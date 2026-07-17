# CodeWithSammy

Marketing site + registration flow for the CodeWithSammy coding bootcamp, with a
Paystack-verified payment webhook and a Firebase-backed admin panel.

## What's in here

| Path | What it is |
|------|------------|
| `index.html` | The public website. Handles registration and renders pricing/cohort from admin-managed settings. No payment keys live here. |
| `admin.html` | The admin panel (also served at `/admin`). Firebase Auth login, paid-students list, and pricing/cohort settings editor. |
| `success.html` | Post-payment confirmation page (served at `/success`). Checkout redirects here; it verifies the payment and shows a receipt. |
| `netlify/functions/initialize-payment.js` | Netlify function (`/api/initialize-payment`). Computes the amount server-side from admin prices and starts the transaction with the secret key. |
| `netlify/functions/paystack-webhook.js` | Netlify function. Verifies a payment, then writes the confirmed registration to Firestore with the Admin SDK. |
| `netlify/functions/verify-payment.js` | Read-only Netlify function (`/api/verify-payment`). Confirms a reference so the success page shows a verified result. |
| `firestore.rules` | Firestore security rules. |
| `firebase.json`, `.firebaserc` | Firebase config (used only to deploy the Firestore rules). |
| `netlify.toml` | Netlify build + routing (`/admin`, `/success`, `/api/*`). |
| `package.json` | Declares `firebase-admin` for the Netlify functions. |
| `robots.txt`, `sitemap.xml`, `llms.txt` | SEO / AI-crawler files. |
| `site.webmanifest`, `favicon.svg`, `favicon-*.png`, `apple-touch-icon.png`, `icon-*.png` | Favicons + PWA manifest. |
| `og-image.png` | Social share image (referenced by Open Graph / Twitter tags). |

> **SEO domain:** the SEO tags and files use `https://codewithsammy.com` as the
> production domain. If yours differs, find/replace it across `index.html`,
> `robots.txt`, `sitemap.xml`, and `llms.txt`. After deploying, submit
> `sitemap.xml` in Google Search Console.

## How it works

```
Student → index.html → POST /api/initialize-payment (Netlify function)
                          │  1. compute amount from admin prices (Firestore)
                          │  2. start transaction with the SECRET key
                          ▼
                       redirect to the hosted checkout
                          │  (payment succeeds → redirect to /success)
                          ▼
      Paystack → POST /api/paystack-webhook (Netlify function)
                          │  1. verify signature (HMAC-SHA512)
                          │  2. re-verify txn with Paystack API
                          │  3. write registration via Admin SDK
                          ▼
                     Firestore  ── registrations/{reference}
                          ▲
        Admin → admin.html (Firebase Auth) reads registrations,
                edits config/site (pricing + cohort)
                          │
                          ▼
             index.html reads config/site to render pricing + cohort
```

The browser holds **no payment keys** and **never** writes registrations. The
amount is computed server-side from the admin-managed prices (so it can't be
tampered with), and only the webhook — after verifying the payment directly
with Paystack — writes the record. That makes a forged "paid" registration
impossible.

### Data model

**`registrations/{paystackReference}`** — written by the webhook (and,
temporarily, by the confirmation page — see "Temporary webhook bypass" below):

| Field | Type | Notes |
|-------|------|-------|
| `fullName`, `email`, `phone`, `track`, `plan` | string | From the registration form (via transaction metadata). |
| `planId` | string | `bootcamp` / `student` / `pro`. |
| `cohort` | number | Cohort the student paid for. |
| `people` | number | Number of registrants (Bootcamp groups; 1 otherwise). |
| `participants` | array | Bootcamp group members `{ name, age }` (null for other plans). |
| `amount` | number | Naira (Paystack reports kobo; the webhook divides by 100). |
| `currency` | string | e.g. `NGN`. |
| `status` | string | Always `paid`. |
| `verified` | boolean | `true` — payment verified with Paystack. |
| `paymentRef` | string | Paystack reference (also the doc id). |
| `paidAt`, `createdAt` | timestamp | |

Bootcamp is a teens (13–16) track: extra registrants add `name + age` fields
(max 3 people), and a group of 2+ gets a flat ₦5,000 off the order. The amount
is always recomputed server-side in `initialize-payment`.

**`config/site`** — written by the admin panel, read by the public site:

```json
{
  "cohort": { "number": 7, "startDate": "2026-08-01", "endDate": "2026-10-24" },
  "plans": [
    { "id": "bootcamp", "name": "Bootcamp", "amount": 30000, "benefits": ["...", "..."] },
    { "id": "student", "name": "Student", "amount": 45000, "benefits": ["...", "..."] },
    { "id": "pro", "name": "Pro", "amount": 75000, "benefits": ["...", "..."] }
  ],
  "updatedAt": "2026-07-16T..."
}
```

## Setup

### 1. Firebase

1. In the [Firebase console](https://console.firebase.google.com/), open the
   `codewithsammy-6cf08` project.
2. **Firestore** → create the database (production mode).
3. **Authentication** → Sign-in method → enable **Email/Password**.
4. **Authentication** → Users → add the admin user (email + password).
5. Copy that user's **User UID** and paste it into `firestore.rules` in the
   `isAdmin()` list, replacing `PASTE_ADMIN_UID_HERE`:
   ```
   function isAdmin() {
     return request.auth != null
         && request.auth.uid in ['your-admin-uid-here'];
   }
   ```
6. **Authentication** → Settings → **Authorized domains** → add your Netlify
   domain (and any custom domain).
7. Deploy the rules:
   ```bash
   firebase deploy --only firestore:rules
   ```

### 2. Paystack

Payment is initialized **server-side**, so no public key goes in the frontend —
only the secret key (set in Netlify, step 3). All you configure here is:

1. After the site is deployed (below), set your webhook URL in
   **Settings → API Keys & Webhooks → Webhook URL** to:
   ```
   https://<your-site>.netlify.app/api/paystack-webhook
   ```
   The transaction is created with `callback_url` set to
   `https://<your-site>.netlify.app/success`, so the customer is redirected
   there automatically after paying.

### 3. Netlify

1. Connect this repo to Netlify (or `netlify deploy`). No build command is
   needed — it's a static site with a functions directory.
2. **Site settings → Environment variables** — add:

   | Variable | Value |
   |----------|-------|
   | `PAYSTACK_SECRET_KEY` | Your Paystack **secret** key (`sk_...`). |
   | `FIREBASE_SERVICE_ACCOUNT` | The Firebase service-account JSON as a single-line string. |

   Get the service account from Firebase console → Project settings →
   **Service accounts** → *Generate new private key*, then paste the whole JSON
   (stringified to one line) as the value.
3. Deploy.

### 4. Seed the settings

Visit `/admin`, sign in with the admin account, and click **Save settings**
once. This creates `config/site` so the homepage renders the pricing and cohort
from Firestore.

## Local development

Static files — open `index.html` directly, or serve the folder:

```bash
npx serve .
```

To run the webhook locally, use the Netlify CLI (loads `netlify.toml` and env):

```bash
npm install
netlify dev
```

## Temporary webhook bypass

While the Paystack webhook is being sorted out, the confirmation page
(`success.html`) also saves the registration itself: it calls `verify-payment`
(which confirms the payment with Paystack using the secret key), then writes the
record to Firestore with the Firebase Web SDK, keyed by the payment reference.
Because the id is the reference, this merges with the webhook's write if that
ever runs — no duplicates.

To support this, `firestore.rules` temporarily allows a client to create/update
a `registrations/{ref}` doc when `paymentRef == ref` and it looks paid. **This is
spoofable** (a browser could write a fake "paid" record), so once the webhook is
reliable, remove that `allow create, update` block and delete the write in
`success.html` — the webhook (Admin SDK) is the trustworthy path.

## Security notes

- **Never commit secrets.** `PAYSTACK_SECRET_KEY` and `FIREBASE_SERVICE_ACCOUNT`
  live only in Netlify's environment variables. The Firebase *web* config in
  `index.html` / `admin.html` is public by design and safe to expose.
- **Rotate a leaked service-account key** immediately: Firebase console →
  Project settings → Service accounts → delete the key and generate a new one.
- The webhook path is trustworthy because it verifies each transaction with
  Paystack server-side. The temporary confirmation-page write is verified too,
  but relies on a client-writable rule — see above.
