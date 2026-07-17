"use strict";

/**
 * Lightweight payment-verification endpoint for the success page.
 *
 * The success page (success.html) calls this with the Paystack reference from
 * the redirect URL. We ask Paystack directly whether that reference succeeded
 * — so the page shows a *verified* result instead of trusting a URL param.
 *
 * This is read-only: it does NOT write anything. The authoritative record is
 * still written by the paystack-webhook function. Requires the same env var:
 *   PAYSTACK_SECRET_KEY
 */

const https = require("https");

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
    return json(200, {
      status: tx.status, // "success", "failed", "abandoned", ...
      reference: tx.reference || reference,
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
    });
  } catch (err) {
    console.error("verify-payment failed:", err);
    return json(502, { status: "error", message: "Verification failed" });
  }
};
