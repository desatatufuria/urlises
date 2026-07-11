import { Component, type ErrorInfo, type ReactNode } from "react";

type FailureKind = "boundary" | "error" | "unhandledrejection";

export interface FailureReport {
  kind: FailureKind;
  message: string;
  release: string;
  path: string;
  timestamp: string;
}

function redact(value: unknown) {
  return String(value ?? "Unexpected application error")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(token|password|authorization)=([^\s&]+)/gi, "$1=[redacted]");
}

export function reportFailure(kind: FailureKind, value: unknown) {
  const report: FailureReport = {
    kind,
    message: redact(value instanceof Error ? value.message : value),
    release: import.meta.env.VITE_RELEASE?.trim() || "development",
    path: typeof window === "undefined" ? "" : window.location.pathname,
    timestamp: new Date().toISOString(),
  };
  const sink = import.meta.env.VITE_ERROR_REPORTING_URL?.trim();
  if (sink && typeof fetch !== "undefined") {
    void fetch(sink, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report), keepalive: true }).catch(() => undefined);
  }
  return report;
}

export function installGlobalFailureReporting() {
  window.addEventListener("error", (event) => { reportFailure("error", event.error ?? event.message); });
  window.addEventListener("unhandledrejection", (event) => { reportFailure("unhandledrejection", event.reason); });
  if (typeof performance !== "undefined") performance.mark("admin-web:boot");
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { reportFailure("boundary", error); }
  render() {
    if (this.state.failed) return <main role="alert"><h1>Something went wrong</h1><p>The failure was reported safely. Reload to retry.</p></main>;
    return this.props.children;
  }
}
