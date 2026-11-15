import { lookup, resolveSrv, resolveTxt } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { NextResponse } from "next/server";
import { prisma, getDatabaseErrorDiagnostics } from "@/lib/db";
import { ADMIN_COOKIE_NAME, ADMIN_EMAIL, getSession } from "@/lib/auth";
import { isAdminSession } from "@/lib/session-policy.mjs";
import { logServerError } from "@/lib/server-log.mjs";

type Stage = {
  status: "passed" | "failed" | "skipped";
  reason?: string;
  code?: string;
  errorType?: string;
};

type TargetReport = {
  hostname: string;
  port: number;
  dns: Stage & { addressCount?: number };
  tcp: Stage;
  tls: Stage;
};

type DiagnosticReport = {
  ok: boolean;
  checkedAt: string;
  databaseUrlPresent: boolean;
  uriScheme?: "mongodb" | "mongodb+srv";
  uriHostname?: string;
  tlsRequested?: boolean;
  targets: TargetReport[];
  srv: Stage & { recordCount?: number };
  txt: Stage & { recordCount?: number };
  prismaConnect: Stage;
  mongoPing: Stage;
};

const DIAGNOSTIC_COOLDOWN_MS = 15_000;
const NETWORK_PROBE_TIMEOUT_MS = 3_000;
const PRISMA_PROBE_TIMEOUT_MS = 12_000;
let nextCheckAt = 0;
let lastResult: DiagnosticReport | null = null;
let inFlight: Promise<DiagnosticReport> | null = null;

function parseMongoTargets(connectionString: string, scheme: "mongodb" | "mongodb+srv") {
  const withoutScheme = connectionString.slice(scheme.length + 3);
  const authority = withoutScheme.split(/[/?#]/, 1)[0];
  const hostList = authority.slice(authority.lastIndexOf("@") + 1);
  if (!hostList) throw Object.assign(new Error(), { code: "URI_HOST_MISSING" });

  return hostList.split(",").slice(0, 3).map((entry) => {
    let hostname: string;
    let port = 27017;
    if (entry.startsWith("[")) {
      const closingBracket = entry.indexOf("]");
      if (closingBracket < 0) throw Object.assign(new Error(), { code: "URI_HOST_INVALID" });
      hostname = entry.slice(1, closingBracket);
      if (entry[closingBracket + 1] === ":") port = Number(entry.slice(closingBracket + 2));
    } else {
      const colon = entry.lastIndexOf(":");
      if (colon > -1 && entry.indexOf(":") === colon) {
        hostname = entry.slice(0, colon);
        port = Number(entry.slice(colon + 1));
      } else hostname = entry;
    }
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error(), { code: "URI_HOST_INVALID" });
    }
    return { hostname, port };
  });
}

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
    const finish = (stage: Stage) => {
      socket.destroy();
      resolve(stage);
    };
    socket.setTimeout(NETWORK_PROBE_TIMEOUT_MS, () => finish({ status: "failed", reason: "CONNECTION_TIMEOUT", code: "ETIMEDOUT" }));
    socket.once("connect", () => finish({ status: "passed" }));
    socket.once("error", (error) => finish(stageFromError(error)));
  });
}

function probeTls(hostname: string, port: number): Promise<Stage> {
  return new Promise((resolve) => {
    let socket: tls.TLSSocket;
    try {
      socket = tls.connect({ host: hostname, port, servername: net.isIP(hostname) ? undefined : hostname });
    } catch (error) {
      resolve(stageFromError(error));
      return;
    }
    const finish = (stage: Stage) => {
      socket.destroy();
      resolve(stage);
    };
    socket.setTimeout(NETWORK_PROBE_TIMEOUT_MS, () => finish({ status: "failed", reason: "TLS_HANDSHAKE_TIMEOUT", code: "ETIMEDOUT" }));
    socket.once("secureConnect", () => finish({ status: "passed" }));
    socket.once("error", (error) => finish(stageFromError(error)));
  });
}

async function getDatabaseReport(): Promise<DiagnosticReport> {
  const checkedAt = new Date().toISOString();
  const connectionString = process.env.DATABASE_URL;
  const base: DiagnosticReport = {
    ok: false,
    checkedAt,
    databaseUrlPresent: Boolean(connectionString?.trim()),
    targets: [],
    srv: { status: "skipped", reason: "NOT_APPLICABLE" },
    txt: { status: "skipped", reason: "NOT_APPLICABLE" },
    prismaConnect: { status: "skipped", reason: "NOT_RUN" },
    mongoPing: { status: "skipped", reason: "NOT_RUN" },
  };
  if (!connectionString?.trim()) {
    base.prismaConnect = { status: "skipped", reason: "DATABASE_URL_MISSING" };
    base.mongoPing = { status: "skipped", reason: "DATABASE_URL_MISSING" };
    return base;
  }

  const scheme = connectionString.startsWith("mongodb+srv://") ? "mongodb+srv" :
    connectionString.startsWith("mongodb://") ? "mongodb" : undefined;
  if (!scheme) {
    base.prismaConnect = { status: "skipped", reason: "UNSUPPORTED_URI_SCHEME" };
    base.mongoPing = { status: "skipped", reason: "UNSUPPORTED_URI_SCHEME" };
    return base;
  }
  base.uriScheme = scheme;

  let parsedTargets: Array<{ hostname: string; port: number }>;
  try {
    parsedTargets = parseMongoTargets(connectionString, scheme);
  } catch (error) {
    const stage = stageFromError(error);
    base.srv = stage;
    base.prismaConnect = { status: "skipped", reason: "URI_PARSE_FAILED" };
    base.mongoPing = { status: "skipped", reason: "URI_PARSE_FAILED" };
    return base;
  }
  base.uriHostname = parsedTargets[0].hostname;
  base.tlsRequested = scheme === "mongodb+srv" || /[?&](tls|ssl)=true(?:&|$)/i.test(connectionString);

  if (scheme === "mongodb+srv") {
    const srvBaseHostname = parsedTargets[0].hostname;
    const srvName = `_mongodb._tcp.${srvBaseHostname}`;
    try {
      const records = await resolveSrv(srvName);
      const selectedRecords = records.slice(0, 3);
      base.srv = { status: records.length ? "passed" : "failed", ...(records.length ? { recordCount: records.length } : { reason: "SRV_RECORDS_NOT_FOUND" }) };
      parsedTargets = selectedRecords.map((record) => ({ hostname: record.name.replace(/\.$/, ""), port: record.port }));
    } catch (error) {
      base.srv = stageFromError(error);
      parsedTargets = [];
    }
    try {
      const records = await resolveTxt(srvBaseHostname);
      base.txt = { status: "passed", recordCount: records.length };
    } catch (error) {
      base.txt = stageFromError(error);
    }
  }

  base.targets = await Promise.all(parsedTargets.map(async ({ hostname, port }) => {
    let dns: TargetReport["dns"];
    try {
      const addresses = net.isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
      dns = { status: addresses.length ? "passed" : "failed", addressCount: addresses.length, ...(!addresses.length ? { reason: "NO_ADDRESSES" } : {}) };
    } catch (error) {
      dns = stageFromError(error);
    }
    const tcp = await probeTcp(hostname, port);
    const tlsStage = await probeTls(hostname, port);
    return { hostname, port, dns, tcp, tls: tlsStage };
  }));

  let prismaTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$connect(),
      new Promise<never>((_, reject) => {
        prismaTimeout = setTimeout(() => reject(Object.assign(new Error(), { code: "ETIMEDOUT" })), PRISMA_PROBE_TIMEOUT_MS);
      }),
    ]);
    base.prismaConnect = { status: "passed" };
    try {
      await prisma.$runCommandRaw({ ping: 1 });
      base.mongoPing = { status: "passed" };
      base.ok = true;
    } catch (error) {
      base.mongoPing = stageFromError(error);
      logServerError("security.admin.database_ping_failed", error);
    }
  } catch (error) {
    base.prismaConnect = stageFromError(error);
    base.mongoPing = { status: "skipped", reason: "PRISMA_CONNECT_FAILED" };
    logServerError("security.admin.database_connect_failed", error);
  } finally {
    if (prismaTimeout) clearTimeout(prismaTimeout);
  }
  return base;
}

export async function GET() {
  // Validate the signed admin cookie without querying MongoDB, so this check
  // remains usable while database-backed session revocation is unavailable.
  const session = await getSession(undefined, ADMIN_COOKIE_NAME);
  if (!session || !isAdminSession(session, ADMIN_EMAIL)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = Date.now();
  if (lastResult && now < nextCheckAt) {
    return NextResponse.json(lastResult, { status: lastResult.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  }

  if (!inFlight) inFlight = getDatabaseReport();
  try {
    lastResult = await inFlight;
  } finally {
    inFlight = null;
    nextCheckAt = Date.now() + DIAGNOSTIC_COOLDOWN_MS;
  }
  return NextResponse.json(lastResult, { status: lastResult.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
