"use strict";

/**
 * Payment-verification endpoint for the success page.
 *
 * The success page (success.html) calls this with the Paystack reference from
 * the redirect URL. We ask Paystack directly whether that reference succeeded
 * — so the page shows a *verified* result instead of trusting a URL param.
 *
 * It ALSO persists the confirmed registration to Firestore via the Admin SDK
 * (bypassing security rules), so students are saved even when the Paystack
 * webhook isn't firing. This is best-effort and guarded: if the service
 * account isn't configured it simply skips the write and returns saved:false.
 *
 * Env vars:
 *   PAYSTACK_SECRET_KEY       - required (verify with Paystack)
 *   FIREBASE_SERVICE_ACCOUNT  - optional (enables the server-side save)
 */

const https = require("https");

// Initialise firebase-admin lazily and defensively — a missing/invalid service
// account must NOT crash the function (verification still needs to work).
let db = null;
let admin = null;
try {
  admin = require("firebase-admin");
  if (!admin.apps.length) {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (sa) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
    }
  }
  if (admin.apps.length) db = admin.firestore();
} catch (err) {
  console.warn("verify-payment: Firebase Admin unavailable —", err.message);
  db = null;
}

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
  // Bootcamp group details live at the top level of metadata, not custom_fields.
  out.plan_id = meta.plan_id || "";
  out.people = meta.people;
  out.participants = Array.isArray(meta.participants) ? meta.participants : null;
  return out;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  const reference =
    event.queryStringParameters && event.queryStringParameters.reference;
  if (!reference) {
    return json(400, { status: "error", message: "Missing reference" });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    console.error("PAYSTACK_SECRET_KEY is not configured");
    return json(500, { status: "error", message: "Server not configured" });
  }

  try {
    const verification = await verifyTransaction(reference, secretKey);
    const tx = verification && verification.data;
    if (!verification.status || !tx) {
      return json(200, { status: "unknown", reference });
    }
    const meta = readMetadata(tx.metadata);
    const ref = tx.reference || reference;

    // Persist the confirmed registration server-side (Admin SDK bypasses
    // Firestore rules). Best-effort — never blocks the verified response.
    let saved = false;
    let saveError = null;
    if (tx.status === "success" && db) {
      try {
        const docRef = db.collection("registrations").doc(ref);
        await db.runTransaction(async (t) => {
          const existing = await t.get(docRef);
          t.set(
            docRef,
            {
              fullName: meta.full_name || "",
              email: (tx.customer && tx.customer.email) || "",
              phone: meta.phone || "",
              track: meta.track || "",
              plan: meta.plan || "",
              planId: meta.plan_id || "",
              cohort: meta.cohort ? Number(meta.cohort) : null,
              people: meta.people ? Number(meta.people) : 1,
              participants: meta.participants || null,
              amount: (tx.amount || 0) / 100,
              currency: tx.currency || "NGN",
              status: "paid",
              verified: true,
              paymentRef: ref,
              source: "verify-payment",
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              createdAt: existing.exists
                ? existing.data().createdAt
                : admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        });
        saved = true;
      } catch (e) {
        saveError = e.message;
        console.error("verify-payment: save failed:", e);
      }
    } else if (tx.status === "success" && !db) {
      saveError = "FIREBASE_SERVICE_ACCOUNT not configured";
    }

    return json(200, {
      status: tx.status, // "success", "failed", "abandoned", ...
      reference: ref,
      amount: (tx.amount || 0) / 100, // kobo -> naira
      currency: tx.currency || "NGN",
      email: (tx.customer && tx.customer.email) || "",
      name: meta.full_name || "",
      phone: meta.phone || "",
      track: meta.track || "",
      plan: meta.plan || "",
      planId: meta.plan_id || "",
      cohort: meta.cohort || "",
      people: meta.people != null ? Number(meta.people) : 1,
      participants: meta.participants || null,
      saved: saved,
      saveError: saveError,
    });
  } catch (err) {
    console.error("verify-payment failed:", err);
    return json(502, { status: "error", message: "Verification failed" });
  }
};
