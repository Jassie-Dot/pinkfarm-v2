# Hostinger MySQL setup

This project is a server-rendered Next.js app with API routes. Deploy it as a Hostinger **Node.js Web App** (not a static/PHP site); Hostinger offers Node.js apps on Business/Unlimited Web and Cloud plans. The project targets Node 22 and builds with webpack for compatibility with Hostinger's Next.js 16 build environment. Prisma's MySQL connector supports Hostinger's MariaDB database engine. The database starts empty; the setup does not copy records from MongoDB.

## 1. Create the database in hPanel

Create a MySQL database and database user for the same Hostinger account that runs the Node.js app. Save the database name, username, and password securely. The Hostinger account shown in the setup screenshot has collaborator access, so confirm the database is being created on the account that will host the app.

## 2. Set the app environment

In the Hostinger Node.js app environment, set `DATABASE_URL` to the MySQL URL for that account. For an app and database on the same Hostinger hosting account, Hostinger documents `127.0.0.1` on port `3306` as the connection host. Use the actual prefixed database name and username from hPanel, and percent-encode reserved characters in the username or password. Keep the connection-pool options shown here; the app also supplies these limits when they are omitted:

```text
mysql://DATABASE_USER:DATABASE_PASSWORD@127.0.0.1:3306/DATABASE_NAME?connection_limit=5&connect_timeout=5&pool_timeout=5
```

Also configure `SESSION_SECRET` (at least 32 random characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 8 characters), and the Brevo email variables used for sign-in. Add `LOCATIONIQ_API_KEY` if reverse geocoding is enabled, `RAZORPAY_*` secrets only if that payment flow is enabled, and `BLOB_READ_WRITE_TOKEN` if admin hero-video uploads should use Vercel Blob. These are separate integrations; none replaces the Hostinger SQL connection. Do not put real credentials in this repository.

## 3. Create the empty schema and initial store data

Hostinger's managed Node.js plans run npm commands as part of a deployment build and do not provide npm through SSH. In the app's Build settings, temporarily set the build command to:

```text
npm run db:provision && npm run build
```

This command needs `DATABASE_URL` and `ADMIN_PASSWORD` available during the build. Set `ADMIN_EMAIL` too if the administrator should use a different email from the project's default. `db:provision` creates the MariaDB tables from `prisma/schema.prisma`, then seeds initial store settings, the administrator account, six starter products, and their variants. It does not transfer or delete MongoDB data. The seed is safe to repeat: it creates missing records but leaves existing admin passwords, settings, and products unchanged. Once the initial deployment succeeds, restore the normal build command, `npm run build`, so future deployments do not automatically change the database schema.

## 4. Verify from the running app

Set the app's start command to `npm run start` if Hostinger does not detect it automatically. Sign in to the admin area, open Settings → Database diagnostics, and run the MySQL checks. DNS, TCP, Prisma connection, and the read-only `SELECT 1` ping must pass there. A successful local build does not verify database credentials or Hostinger connectivity.

If database failure blocks administrator sign-in, temporarily set a strong random `DATABASE_DIAGNOSTIC_TOKEN` in Hostinger and redeploy. While viewing the site, run this in the browser developer console, replacing the placeholder with that token:

```js
fetch("/api/admin/database/diagnostics", {
  headers: { "x-database-diagnostic-token": "YOUR_TEMPORARY_DIAGNOSTIC_TOKEN" },
  cache: "no-store",
}).then((response) => response.json()).then(console.log)
```

The report omits credentials. Remove `DATABASE_DIAGNOSTIC_TOKEN` after diagnosis and redeploy.
