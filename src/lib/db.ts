import { PrismaClient } from "@prisma/client";

// Store reads have safe local fallbacks, so don't hold the storefront open
// while MySQL is unreachable. The cooldown avoids retrying a failed connection
// on every request.
const isCI = Boolean(process.env.CI) && !process.env.VERCEL;
const DB_QUERY_TIMEOUT_MS = isCI ? 4_000 : 8_000;
const DB_RETRY_COOLDOWN_MS = 5_000;
let databaseUnavailableUntil = 0;
let lastDatabaseWarningAt = 0;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

type CachedPrismaSchema = PrismaClient & {
  coupon?: unknown;
  productReview?: unknown;
  productComment?: unknown;
  _runtimeDataModel?: {
    models?: Record<string, { fields?: Array<{ name: string; isRequired: boolean }> }>;
  };
};

// During development a hot reload can retain a client generated from an older
// Prisma schema. Recreate it when the generated client lacks current models or
// the nullable product snapshot fields used to preserve order history on delete.
const cachedPrisma = globalForPrisma.prisma as CachedPrismaSchema | undefined;
const cachedOrderItemFields = cachedPrisma?._runtimeDataModel?.models?.OrderItem?.fields;
const cachedOrderItemSchemaIsCurrent = Boolean(
  cachedOrderItemFields?.some((field) => field.name === "productName") &&
    cachedOrderItemFields?.some((field) => field.name === "productSlug") &&
    cachedOrderItemFields?.some((field) => field.name === "productImageUrl") &&
    cachedOrderItemFields?.some((field) => field.name === "productId" && !field.isRequired),
);
export const prisma =
  (cachedPrisma?.coupon && cachedPrisma.productReview && cachedPrisma.productComment && cachedOrderItemSchemaIsCurrent ? cachedPrisma : undefined) ??
  new PrismaClient({
    log: [],
    ...(process.env.DATABASE_URL
      ? { datasources: { db: { url: withMySqlPoolLimits(process.env.DATABASE_URL) } } }
      : {}),
  });

/** Keep a single Hostinger Node.js process from opening Prisma's CPU-scaled default pool. */
function withMySqlPoolLimits(connectionString: string): string {
  if (!connectionString.startsWith("mysql://")) return connectionString;
  try {
    const url = new URL(connectionString);
    if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "5");
    if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "5");
    if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "5");
    return url.toString();
  } catch {
    // Let Prisma report malformed URLs itself; don't mask the configured value.
    return connectionString;
  }
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export async function queryDatabase<T>(
  operation: () => Promise<T>,
  timeoutMs = DB_QUERY_TIMEOUT_MS,
  options: { isolateCooldown?: boolean } = {},
): Promise<T> {
  const shouldCheckCooldown = !options.isolateCooldown;
  if (shouldCheckCooldown && performance.now() < databaseUnavailableUntil) {
    throw new Error("Database is temporarily unavailable");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Database query timed out")),
          timeoutMs,
        );
      }),
    ]);
    if (!options.isolateCooldown) databaseUnavailableUntil = 0;
    return result;
  } catch (error) {
    if (!options.isolateCooldown) databaseUnavailableUntil = performance.now() + DB_RETRY_COOLDOWN_MS;
    if (performance.now() - lastDatabaseWarningAt >= DB_RETRY_COOLDOWN_MS) {
      const diagnostics = getDatabaseErrorDiagnostics(error);
      console.warn("Database operation failed.", diagnostics);
      lastDatabaseWarningAt = performance.now();
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Return stable, non-sensitive connection diagnostics; never include error messages or URIs. */
export function getDatabaseErrorDiagnostics(error: unknown) {
  let candidate = error as { name?: unknown; code?: unknown; errorCode?: unknown; cause?: unknown } | null;
  let errorType = "DatabaseError";
  let rawCode: string | undefined;
  const visited = new Set<unknown>();
  for (let depth = 0; candidate && depth < 4 && !visited.has(candidate); depth++) {
    visited.add(candidate);
    if (errorType === "DatabaseError" && typeof candidate.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate.name)) errorType = candidate.name;
    const value = typeof candidate.code === "string" ? candidate.code :
      typeof candidate.errorCode === "string" ? candidate.errorCode : undefined;
    if (value && /^[A-Z0-9_]{2,40}$/.test(value)) {
      rawCode = value;
      break;
    }
    candidate = candidate.cause as typeof candidate;
  }
  const code = rawCode && /^[A-Z0-9_]{2,40}$/.test(rawCode) ? rawCode : undefined;

  let reason = "DATABASE_UNAVAILABLE";
  if (code === "ECONNREFUSED") reason = "CONNECTION_REFUSED";
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN") reason = "DNS_LOOKUP_FAILED";
  else if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") reason = "CONNECTION_TIMEOUT";
  else if (code === "TLS_ERROR" || code === "CERT_HAS_EXPIRED") reason = "TLS_FAILURE";
  else if (code === "P1001") reason = "DATABASE_HOST_UNREACHABLE";
  else if (code === "P1002" || code === "P1008") reason = "CONNECTION_TIMEOUT";
  else if (code === "P1017") reason = "DATABASE_CONNECTION_CLOSED";
  else if (code === "P1000") reason = "AUTHENTICATION_FAILED";
  else if (code === "P1010") reason = "DATABASE_PERMISSION_DENIED";
  else if (/Authentication/i.test(errorType)) reason = "AUTHENTICATION_FAILED";
  else if (/KnownRequest/i.test(errorType) && code?.startsWith("P")) reason = "PRISMA_REQUEST_FAILED";

  return { errorType, ...(code ? { code } : {}), reason };
}
