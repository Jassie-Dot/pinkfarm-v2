"use client";

import { useState } from "react";

type DiagnosticStage = {
  status: "passed" | "failed" | "skipped";
  reason?: string;
  code?: string;
  errorType?: string;
  addressCount?: number;
  recordCount?: number;
};

type DiagnosticResult = {
  ok: boolean;
  checkedAt: string;
  databaseUrlPresent?: boolean;
  uriScheme?: string;
  uriHostname?: string;
  tlsRequested?: boolean;
  srv: DiagnosticStage;
  txt: DiagnosticStage;
  targets: Array<{ hostname: string; port: number; dns: DiagnosticStage; tcp: DiagnosticStage; tls: DiagnosticStage }>;
  prismaConnect: DiagnosticStage;
  mongoPing: DiagnosticStage;
};

function formatStage(label: string, stage: DiagnosticStage) {
  const detail = stage.reason ?? stage.code ?? (stage.addressCount !== undefined ? `${stage.addressCount} address(es)` : stage.recordCount !== undefined ? `${stage.recordCount} record(s)` : "");
  const code = stage.code && stage.code !== detail ? ` (${stage.code})` : "";
  return `${label}: ${stage.status}${detail ? ` — ${detail}${code}` : ""}`;
}

export function DatabaseDiagnostic() {
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [checking, setChecking] = useState(false);

  async function checkConnection() {
    setChecking(true);
    try {
      const response = await fetch("/api/admin/database/diagnostics", { cache: "no-store" });
      const data = await response.json();
      setResult(data);
    } catch {
      setResult({
        ok: false,
        checkedAt: new Date().toISOString(),
        databaseUrlPresent: undefined,
        srv: { status: "skipped" },
        txt: { status: "skipped" },
        targets: [],
        prismaConnect: { status: "failed", reason: "REQUEST_FAILED" },
        mongoPing: { status: "skipped" },
      });
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-stone-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="font-semibold text-stone-900">MongoDB connection</h2>
        <p className="text-sm text-stone-600">Run a safe ping against the configured database. Credentials are never shown.</p>
        {result && <p role="status" className={`mt-2 text-sm font-medium ${result.ok ? "text-green-700" : "text-red-700"}`}>
          {result.ok ? "MongoDB is reachable." : "MongoDB checks did not all pass."}
          {` Checked ${new Date(result.checkedAt).toLocaleString()}.`}
        </p>}
        {result && <div className="mt-2 space-y-1 text-xs text-stone-600" aria-live="polite">
          {result.databaseUrlPresent !== undefined && <p>{`DATABASE_URL: ${result.databaseUrlPresent ? "present" : "missing"}${result.uriScheme ? ` (${result.uriScheme})` : ""}${result.uriHostname ? ` · URI hostname ${result.uriHostname}` : ""}${result.tlsRequested !== undefined ? ` · TLS ${result.tlsRequested ? "requested" : "not requested"}` : ""}`}</p>}
          <p>{formatStage("DNS SRV", result.srv)} · {formatStage("DNS TXT", result.txt)}</p>
          {result.targets.map((target) => <p key={`${target.hostname}:${target.port}`}>
            {`${target.hostname}:${target.port} — ${formatStage("DNS", target.dns)} · ${formatStage("TCP", target.tcp)} · ${formatStage("TLS", target.tls)}`}
          </p>)}
          <p>{formatStage("Prisma connect", result.prismaConnect)} · {formatStage("MongoDB ping", result.mongoPing)}</p>
        </div>}
      </div>
      <button type="button" onClick={checkConnection} disabled={checking} className="shrink-0 rounded-xl bg-[#1A4031] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
        {checking ? "Checking…" : "Check connection"}
      </button>
    </section>
  );
}
