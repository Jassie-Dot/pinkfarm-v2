# Hostinger MySQL setup

This project now uses Prisma's MySQL connector, which supports Hostinger's MariaDB database engine. It starts with an empty database; it does not copy records from the former MongoDB database.

## 1. Create the database in hPanel

Create a MySQL database and database user for the same Hostinger account that runs the Node.js app. Save the database name, username, and password securely. The Hostinger account shown in the setup screenshot has collaborator access, so confirm the database is being created on the account that will host the app.

## 2. Set the app environment

In the Hostinger Node.js app environment, set `DATABASE_URL` to the MySQL URL for that account. For an app and database on the same Hostinger hosting account, Hostinger documents `127.0.0.1` on port `3306` as the connection host. Use the actual prefixed database name and username from hPanel, and percent-encode reserved characters in the username or password:

```text
mysql://DATABASE_USER:DATABASE_PASSWORD@127.0.0.1:3306/DATABASE_NAME
```

Also set the app's existing required environment variables, including `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 8 characters), and the payment/authentication secrets used by the live application. Do not put real credentials in this repository.

## 3. Create the empty schema and initial store data

After the app environment is configured, run these from the project directory on the Hostinger app:

```text
npm run db:push
npm run db:seed
```

`db:push` creates the MySQL tables from `prisma/schema.prisma`. It does not transfer or delete MongoDB data. `db:seed` creates the initial store settings, administrator account, six starter products, and their variants. The seed script updates the administrator password for the configured `ADMIN_EMAIL` if that account already exists, so run it again only when that password reset is intended.

## 4. Verify from the running app

Sign in to the admin area, open Settings → Database diagnostics, and run the MySQL checks. DNS, TCP, Prisma connection, and the read-only `SELECT 1` ping must pass there. A successful local build does not verify database credentials or Hostinger connectivity.
