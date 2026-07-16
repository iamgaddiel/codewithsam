"use strict";

/**
 * Paystack webhook for CodeWithSammy.
 *
 * Flow:
 *   1. Paystack POSTs an event to this function whenever a charge happens.
 *   2. We verify the request signature (HMAC-SHA512 of the raw body with the
 *      Paystack secret key) so we know the call really came from Paystack.
 *   3. For a `charge.success` event we re-verify the transaction directly with
 *      the Paystack API (never trust the payload alone).
 *   4. We write the confirmed registration to Firestore using the Admin SDK,
 *      which bypasses the Firestore security rules. The document id is the
 *      Paystack reference, so retried webhooks are idempotent (no duplicates).
 *
 * The registration details (name, phone, track, plan) come from the Paystack
 * transaction metadata that the website attaches when opening the checkout.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const https = require("https");

admin.initializeApp();
const db = admin.firestore();

// Set with:  firebase functions:secrets:set PAYSTACK_SECRET_KEY
const PAYSTACK_SECRET_KEY = defineSecret("PAYSTACK_SECRET_KEY");

/**
 * Ask Paystack directly whether a reference really succeeded.
 * Returns the parsed JSON response.
 */
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
  // Fall back to any top-level metadata keys too.
  ["full_name", "phone", "track", "plan"].forEach((key) => {
    if (out[key] === undefined && meta[key] !== undefined) out[key] = meta[key];
  });
  return out;
}

exports.paystackWebhook = onRequest(
  { secrets: [PAYSTACK_SECRET_KEY], cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const secretKey = PAYSTACK_SECRET_KEY.value();

    // 1. Verify the signature against the RAW request body.
    const signature = req.headers["x-paystack-signature"];
    const expected = crypto
      .createHmac("sha512", secretKey)
      .update(req.rawBody)
      .digest("hex");
    if (
      !signature ||
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      logger.warn("Rejected webhook: invalid Paystack signature");
      return res.status(401).send("Invalid signature");
    }

    const event = req.body || {};

    // Only care about successful charges; ack everything else.
    if (event.event !== "charge.success") {
      return res.status(200).send("Ignored");
    }

    const reference = event.data && event.data.reference;
    if (!reference) {
      return res.status(400).send("Missing reference");
    }

    try {
      // 2. Re-verify the transaction with Paystack (source of truth).
      const verification = await verifyTransaction(reference, secretKey);
      const tx = verification && verification.data;
      if (!verification.status || !tx || tx.status !== "success") {
        logger.warn("Transaction did not verify as successful", { reference });
        return res.status(200).send("Not successful");
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

      logger.info("Registration confirmed", { reference });
      return res.status(200).send("OK");
    } catch (err) {
      logger.error("Webhook processing failed", err);
      // 500 tells Paystack to retry later.
      return res.status(500).send("Error");
    }
  }
);
