import { lookup } from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";
import net from "node:net";
import { NextResponse } from "next/server";
import { prisma, getDatabaseErrorDiagnostics } from "@/lib/db";
import { ADMIN_COOKIE_NAME, ADMIN_EMAIL, getSession } from "@/lib/auth";
import { isAdminSession } from "@/lib/session-policy.mjs";
import { logServerError } from "@/lib/server-log.mjs";

type Stage = { status: "passed" | "failed" | "skipped"; reason?: string; code?: string; errorType?: string };
type Report = {
  ok: boolean;
  checkedAt: string;
  databaseUrlPresent: boolean;
  uriScheme?: string;
  uriHostname?: string;
  dns: Stage & { addressCount?: number };
  tcp: Stage;
  prismaConnect: Stage;
  mysqlPing: Stage;
};

const COOLDOWN_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;
let nextCheckAt = 0;
let lastResult: Report | null = null;
let inFlight: Promise<Report> | null = null;

function stageFromError(error: unknown): Stage {
  const safe = getDatabaseErrorDiagnostics(error);
  return { status: "failed", reason: safe.reason, ...(safe.code ? { code: safe.code } : {}), errorType: safe.errorType };
}

function probeTcp(hostname: string, port: number): Promise<Stage> {
  return new Promise((resolve) => {
    let socket: net.Socket;
    try {
      socket = net.createConnection({ host: hostname, port });
    } catch (error) {
      resolve(stageFromError(error));
      return;
    }
    const finish = (stage: Stage) => { socket.destroy(); resolve(stage); };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish({ status: "failed", reason: "CONNECTION_TIMEOUT", code: "ETIMEDOUT" }));
    socket.once("connect", () => finish({ status: "passed" }));
    socket.once("error", (error) => finish(stageFromError(error)));
  });
}

async function getDatabaseReport(): Promise<Report> {
  const connectionString = process.env.DATABASE_URL?.trim();
  const base: Report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    databaseUrlPresent: Boolean(connectionString),
    dns: { status: "skipped", reason: "NOT_RUN" },
    tcp: { status: "skipped", reason: "NOT_RUN" },
    prismaConnect: { status: "skipped", reason: "NOT_RUN" },
    mysqlPing: { status: "skipped", reason: "NOT_RUN" },
  };
  if (!connectionString) {
    base.prismaConnect = { status: "skipped", reason: "DATABASE_URL_MISSING" };
    base.mysqlPing = { status: "skipped", reason: "DATABASE_URL_MISSING" };
    return base;
  }

  let url: URL;
  try {
    url = new URL(connectionString);
    if (url.protocol !== "mysql:") throw new Error("Unsupported database URL scheme");
    base.uriScheme = url.protocol.slice(0, -1);
    base.uriHostname = url.hostname;
  } catch {
    base.dns = { status: "skipped", reason: "DATABASE_URL_INVALID" };
    base.prismaConnect = { status: "skipped", reason: "DATABASE_URL_INVALID" };
    base.mysqlPing = { status: "skipped", reason: "DATABASE_URL_INVALID" };
    return base;
  }

  try {
    const addresses = await lookup(url.hostname, { all: true });
    base.dns = addresses.length ? { status: "passed", addressCount: addresses.length } : { status: "failed", reason: "NO_ADDRESSES" };
  } catch (error) {
    base.dns = stageFromError(error);
  }

  const port = Number(url.port || 3306);
  base.tcp = await probeTcp(url.hostname, port);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$connect(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error(), { code: "ETIMEDOUT" })), 12_000); }),
    ]);
    base.prismaConnect = { status: "passed" };
    try {
      await prisma.$queryRaw`SELECT 1`;
      base.mysqlPing = { status: "passed" };
      base.ok = true;
    } catch (error) {
      base.mysqlPing = stageFromError(error);
      logServerError("security.admin.database_ping_failed", error);
    }
  } catch (error) {
    base.prismaConnect = stageFromError(error);
    base.mysqlPing = { status: "skipped", reason: "PRISMA_CONNECT_FAILED" };
    logServerError("security.admin.database_connect_failed", error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return base;
}

function hasDiagnosticToken(request: Request): boolean {
  const expected = process.env.DATABASE_DIAGNOSTIC_TOKEN;
  const supplied = request.headers.get("x-database-diagnostic-token");
  if (!expected || !supplied || expected.length > 512 || supplied.length > 512) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function GET(request: Request) {
  // Keep the endpoint protected while allowing an operator to diagnose a DB
  // outage that also prevents database-backed administrator login.
  if (!hasDiagnosticToken(request)) {
    const session = await getSession(undefined, ADMIN_COOKIE_NAME);
    if (!session || !isAdminSession(session, ADMIN_EMAIL)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (lastResult && Date.now() < nextCheckAt) {
    return NextResponse.json(lastResult, { status: lastResult.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!inFlight) inFlight = getDatabaseReport();
  try {
    lastResult = await inFlight;
  } finally {
    inFlight = null;
    nextCheckAt = Date.now() + COOLDOWN_MS;
  }
  return NextResponse.json(lastResult, { status: lastResult.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
