"use strict";

/**
 * Issues short-lived ImageKit upload credentials to the signed-in admin.
 *
 * The browser uploads the popup flyer straight to ImageKit, so the file never
 * passes through this function (Netlify caps function payloads at ~6 MB). What
 * the browser cannot have is the ImageKit PRIVATE key, so it asks here for a
 * signed one-shot token instead.
 *
 * Access is admin-only: the caller must send a Firebase ID token, which we
 * verify with the Admin SDK and match against ADMIN_UIDS. Without that anyone
 * could mint upload tokens for the account.
 *
 * Required environment variables:
 *   IMAGEKIT_PUBLIC_KEY       - ImageKit public key (public_...)
 *   IMAGEKIT_PRIVATE_KEY      - ImageKit private key (private_...)
 *   IMAGEKIT_URL_ENDPOINT     - e.g. https://ik.imagekit.io/your_id
 *   ADMIN_UIDS                - comma-separated Firebase UIDs allowed to upload
 *   FIREBASE_SERVICE_ACCOUNT  - Firebase service-account JSON (string)
 */

const crypto = require("crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// ImageKit tokens are single-use and must expire within 1 hour.
const TOKEN_TTL_SECONDS = 600;

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

function adminUids() {
  return (process.env.ADMIN_UIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { message: "Method Not Allowed" });
  }

  const publicKey = process.env.IMAGEKIT_PUBLIC_KEY;
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;

  if (!publicKey || !privateKey || !urlEndpoint) {
    console.error("ImageKit environment variables are not configured");
    return json(500, { message: "Image uploads are not configured yet." });
  }

  const allowed = adminUids();
  if (!allowed.length) {
    // Fail closed: with no allow-list we cannot tell an admin from any other
    // Firebase user, so refuse rather than hand out upload tokens.
    console.error("ADMIN_UIDS is not configured");
    return json(500, { message: "Image uploads are not configured yet." });
  }

  const header = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const idToken = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!idToken) {
    return json(401, { message: "Sign in as an admin to upload." });
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    console.warn("ID token verification failed:", err.message);
    return json(401, { message: "Your session expired. Sign in again." });
  }

  if (!allowed.includes(uid)) {
    return json(403, { message: "This account isn't authorized to upload images." });
  }

  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const signature = crypto
    .createHmac("sha1", privateKey)
    .update(token + expire)
    .digest("hex");

  return json(200, { token, expire, signature, publicKey, urlEndpoint });
};
