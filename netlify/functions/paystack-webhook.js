"use strict";

/**
 * Paystack webhook for CodeWithSammy — Netlify serverless function.
 *
 * Flow:
 *   1. Paystack POSTs an event here whenever a charge happens.
 *   2. We verify the request signature (HMAC-SHA512 of the raw body with the
 *      Paystack secret key) so we know the call really came from Paystack.
 *   3. For a `charge.success` event we re-verify the transaction directly with
 *      the Paystack API (never trust the payload alone).
 *   4. We write the confirmed registration to Firestore using the Firebase
 *      Admin SDK, which bypasses the Firestore security rules. The document id
 *      is the Paystack reference, so retried webhooks are idempotent.
 *
 * The registration details (name, phone, track, plan) come from the Paystack
 * transaction metadata that the website attaches when opening checkout.
 *
 * Required environment variables (Netlify > Site settings > Environment):
 *   PAYSTACK_SECRET_KEY      - your Paystack secret key (sk_...)
 *   FIREBASE_SERVICE_ACCOUNT - the Firebase service-account JSON (as a string)
 */

const crypto = require("crypto");
const https = require("https");
const admin = require("firebase-admin");

// Initialise the Admin SDK once and reuse it across warm invocations.
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

/** Ask Paystack directly whether a reference really succeeded. */
function verifyTransaction(reference, secretKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.paystack.co",
      path: "/transaction/verify/" + encodeURIComponent(reference),
      method: "GET",
      headers: { Authorization: "Bearer " + secretKey },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Pull custom_fields (and loose keys) out of Paystack metadata into a map. */
function readMetadata(rawMeta) {
  let meta = rawMeta || {};
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch (err) {
      meta = {};
    }
  }
  const out = {};
  (meta.custom_fields || []).forEach((field) => {
    if (field && field.variable_name) out[field.variable_name] = field.value;
  });
  ["full_name", "phone", "track", "plan"].forEach((key) => {
    if (out[key] === undefined && meta[key] !== undefined) out[key] = meta[key];
  });
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    console.error("PAYSTACK_SECRET_KEY is not configured");
    return { statusCode: 500, body: "Server not configured" };
  }

  // Netlify may base64-encode the body; get the exact bytes Paystack signed.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  // 1. Verify the signature against the raw body.
  const signature = event.headers["x-paystack-signature"];
  const expected = crypto
    .createHmac("sha512", secretKey)
    .update(rawBody)
    .digest("hex");
  if (
    !signature ||
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    console.warn("Rejected webhook: invalid Paystack signature");
    return { statusCode: 401, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: "Bad JSON" };
  }

  // Only care about successful charges; ack everything else.
  if (payload.event !== "charge.success") {
    return { statusCode: 200, body: "Ignored" };
  }

  const reference = payload.data && payload.data.reference;
  if (!reference) {
    return { statusCode: 400, body: "Missing reference" };
  }

  try {
    // 2. Re-verify the transaction with Paystack (source of truth).
    const verification = await verifyTransaction(reference, secretKey);
    const tx = verification && verification.data;
    if (!verification.status || !tx || tx.status !== "success") {
      console.warn("Transaction did not verify as successful:", reference);
      return { statusCode: 200, body: "Not successful" };
    }

    const meta = readMetadata(tx.metadata);

    // 3. Write the confirmed registration (Admin SDK bypasses rules).
    const ref = db.collection("registrations").doc(reference);
    await db.runTransaction(async (t) => {
      const existing = await t.get(ref);
      t.set(
        ref,
        {
          fullName: meta.full_name || "",
          email: (tx.customer && tx.customer.email) || "",
          phone: meta.phone || "",
          track: meta.track || "",
          plan: meta.plan || "",
          amount: (tx.amount || 0) / 100, // kobo -> naira
          currency: tx.currency || "NGN",
          status: "paid",
          verified: true,
          paymentRef: reference,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          // Preserve the first-seen time across webhook retries.
          createdAt: existing.exists
            ? existing.data().createdAt
            : admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    console.log("Registration confirmed:", reference);
    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("Webhook processing failed:", err);
    // 500 tells Paystack to retry later.
    return { statusCode: 500, body: "Error" };
  }
};
