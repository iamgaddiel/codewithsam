"use strict";

/**
 * Starts a payment transaction server-side and returns a hosted checkout URL.
 *
 * The browser posts the registration here (no payment keys live on the
 * frontend). We compute the amount authoritatively from the admin-managed
 * prices in Firestore (so it can't be tampered with), initialize the
 * transaction with the SECRET key, and return the checkout URL to redirect to.
 *
 * Required environment variables:
 *   PAYSTACK_SECRET_KEY       - Paystack secret key (sk_...)
 *   FIREBASE_SERVICE_ACCOUNT  - Firebase service-account JSON (string)
 */

const https = require("https");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const GROUP_DISCOUNT = 5000; // flat ₦5,000 off a Bootcamp order of 2+ people
const MAX_PEOPLE = 3;

// Fallback prices if the config doc hasn't been created yet.
const DEFAULT_PLANS = {
  bootcamp: { name: "Bootcamp", amount: 30000 },
  student: { name: "Student", amount: 45000 },
  pro: { name: "Pro", amount: 75000 },
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

// Look up a plan's authoritative price from config/site (admin-managed).
async function getPlan(planId) {
  try {
    const snap = await db.collection("config").doc("site").get();
    if (snap.exists) {
      const plans = (snap.data() || {}).plans || [];
      const found = plans.find((p) => p.id === planId);
      if (found && typeof found.amount === "number") {
        return { name: found.name || planId, amount: found.amount };
      }
    }
  } catch (err) {
    console.warn("Could not read config, using default prices:", err.message);
  }
  return DEFAULT_PLANS[planId] || null;
}

function paystackInitialize(body, secretKey) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.paystack.co",
        path: "/transaction/initialize",
        method: "POST",
        headers: {
          Authorization: "Bearer " + secretKey,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { message: "Method Not Allowed" });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    console.error("PAYSTACK_SECRET_KEY is not configured");
    return json(500, { message: "Payment is not configured yet." });
  }

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch (err) {
    return json(400, { message: "Invalid request." });
  }

  const name = (input.name || "").trim();
  const email = (input.email || "").trim();
  const phone = (input.phone || "").trim();
  const track = (input.track || "").trim();
  const planId = (input.planId || "").trim();
  const cohort = input.cohort;

  if (!name || !phone) {
    return json(400, { message: "Name and phone are required." });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(400, { message: "A valid email is required." });
  }

  const plan = await getPlan(planId);
  if (!plan) {
    return json(400, { message: "Unknown plan selected." });
  }

  // ---- Compute the authoritative amount ----
  let people = 1;
  let participants = null;
  let amount = plan.amount;

  if (planId === "bootcamp") {
    people = Math.min(MAX_PEOPLE, Math.max(1, parseInt(input.people, 10) || 1));
    participants = Array.isArray(input.participants) ? input.participants : [];
    if (participants.length !== people) {
      return json(400, { message: "Please provide details for each participant." });
    }
    for (const p of participants) {
      const age = parseInt(p && p.age, 10);
      if (!p || !String(p.name || "").trim()) {
        return json(400, { message: "Every participant needs a name." });
      }
      if (isNaN(age) || age < 13 || age > 16) {
        return json(400, { message: "Participant ages must be between 13 and 16." });
      }
    }
    amount = people * plan.amount;
    if (people > 1) amount -= GROUP_DISCOUNT;
  }

  if (!(amount > 0)) {
    return json(400, { message: "Invalid amount." });
  }

  const reference =
    "CWS-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const siteUrl =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    (event.headers && event.headers.host ? "https://" + event.headers.host : "");

  const metadata = {
    plan_id: planId,
    people: people,
    participants: participants || undefined,
    custom_fields: [
      { display_name: "Full Name", variable_name: "full_name", value: name },
      { display_name: "Phone", variable_name: "phone", value: phone },
      { display_name: "Track", variable_name: "track", value: track },
      { display_name: "Plan", variable_name: "plan", value: plan.name },
      { display_name: "Cohort", variable_name: "cohort", value: String(cohort == null ? "" : cohort) },
    ],
  };

  try {
    const result = await paystackInitialize(
      {
        email,
        amount: amount * 100, // naira -> kobo
        currency: "NGN",
        reference,
        callback_url: siteUrl ? siteUrl + "/success" : undefined,
        metadata,
      },
      secretKey
    );

    if (result && result.status && result.data && result.data.authorization_url) {
      return json(200, {
        authorization_url: result.data.authorization_url,
        reference: result.data.reference || reference,
      });
    }
    console.error("Paystack initialize failed:", result && result.message);
    return json(502, { message: (result && result.message) || "Could not start payment." });
  } catch (err) {
    console.error("initialize-payment error:", err);
    return json(502, { message: "Could not reach the payment provider." });
  }
};
