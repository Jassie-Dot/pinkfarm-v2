# Pink Farm

Pink Farm is a Next.js storefront for packaged foods. Its server uses Hostinger MariaDB/MySQL through Prisma, Brevo for customer email OTP, signed HTTP-only sessions, and Razorpay for online payments.

## Local setup

1. Install Node.js and run `npm install`.
2. Create a MariaDB/MySQL database and set `DATABASE_URL` using `.env.example`. Hostinger's Node.js app and database should use the Hostinger database host and port documented in [HOSTINGER_MYSQL_SETUP.md](HOSTINGER_MYSQL_SETUP.md).
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, a random `SESSION_SECRET` of at least 32 characters, `BREVO_API_KEY`, `BREVO_FROM_EMAIL` on a verified sender domain, and a strong unique `ADMIN_PASSWORD` (at least 16 characters). The admin email defaults to `pinkfarmofficial@gmail.com`; set `ADMIN_EMAIL` to override it. `ADMIN_JWT_SECRET` is deprecated; sessions and OTPs use `SESSION_SECRET`.
4. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` from the Razorpay dashboard. Use test-mode keys locally and live-mode keys only in production. The key ID is sent to the browser; the key secret must stay server-side. Set `RAZORPAY_WEBHOOK_SECRET` to a separately generated secret for the webhook endpoint; never reuse the API key secret.
5. Run `npm run db:generate`, then `npm run db:push`, then `npm run db:seed`. For a new empty Hostinger database, follow [HOSTINGER_MYSQL_SETUP.md](HOSTINGER_MYSQL_SETUP.md) and use `npm run db:provision` once.
6. Start the store with `npm run dev`.

The seed command creates the admin using the supplied email and a bcrypt password hash. Do not commit `.env` or use development credentials in production.

## Backend state

- Customer sign-in uses a six-digit email code sent through Brevo. Codes are stored as hashes, expire after ten minutes, and permit at most five verification attempts. OTP request, verification, password reset, and password-login attempts are throttled in the configured SQL database. Authentication fails closed if the limiter table is unavailable.
- Admin sessions expire after eight hours; customer sessions expire after 30 days. Sessions use `SESSION_SECRET`, issuer and audience claims, and server-side revocation on logout. Admin pages use Proxy as an early redirect and continue to enforce authorization in the protected layout and API routes.
- Order totals are calculated on the server from current catalog prices, stock, delivery settings, and coupon eligibility. Checkout creates a Razorpay order from the server-calculated total, reserves stock while payment is pending, verifies the payment signature and captured amount server-side, and restores stock when an unpaid checkout is cancelled.
- Payment confirmation uses both the verified browser callback/API fetch and an idempotent `payment.captured` webhook at `/api/webhooks/razorpay`. In Razorpay Dashboard, configure the webhook URL for the deployed environment and subscribe to `payment.captured`; use that webhook's separately configured signing secret as `RAZORPAY_WEBHOOK_SECRET`.
- Customer order history and cancellation are bound to the signed-in customer ID. Guest orders can be created, but are not exposed through the authenticated account.
- Customer profile and address management, transactional notifications, shipping carrier integration, payment collection/refunds, production stock reservations, and deployment monitoring still need implementation before launch.

## Production deployment

For Hostinger, deploy this as a Node.js Web App, configure the variables in hPanel, and use the one-time empty-database setup in [HOSTINGER_MYSQL_SETUP.md](HOSTINGER_MYSQL_SETUP.md). Set `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_PASSWORD`, Brevo sender credentials, and any payment secrets used by the enabled checkout. Use test credentials for local development. Redeploy after changing environment variables. The application uses relative `/api/...` paths, so the same deployment must serve the frontend and backend together.

The `AuthRateLimit` table is part of the current Prisma schema and must exist before authentication flows are used. The Hostinger setup guide explains how to provision it in the new empty database.
