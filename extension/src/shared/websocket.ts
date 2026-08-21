import type { SyncEnvelope } from "./types.js";

const KEEPALIVE_IDLE_MS = 20_000;
const KEEPALIVE_PAYLOAD = JSON.stringify({ type: "keepalive" });

export interface SyncSocketCallbacks {
  onAck: (currentCursor: number) => void | Promise<void>;
  onEvent: (event: SyncEnvelope) => void | Promise<void>;
  /** Optional: a `secret_read` frame (raw, no `{type:"event",...}` wrapper —
   * see design.md's "Hub delivery channel" decision) dispatches here only,
   * never to onEvent. Optional so existing callers/tests that construct
   * SyncSocketCallbacks without it keep working. */
  onSecretRead?: (secretId: string, readAt: string) => void | Promise<void>;
  onResyncRequired: (reason: string) => void | Promise<void>;
  onClose: () => void | Promise<void>;
  onError: (message: string) => void | Promise<void>;
}

export function connectWorkspaceSocket(
  backendUrl: string,
  workspaceId: string,
  ticket: string,
  callbacks: SyncSocketCallbacks,
): () => void {
  const wsUrl = buildWebsocketUrl(backendUrl, workspaceId);
  const protocol = `sbs-ticket.${ticket}`;
  const socket = new WebSocket(wsUrl, [protocol]);
  let keepaliveTimeout: ReturnType<typeof setTimeout> | undefined;

  const clearKeepalive = (): void => {
    if (keepaliveTimeout === undefined) {
      return;
    }
    clearTimeout(keepaliveTimeout);
    keepaliveTimeout = undefined;
  };

  const scheduleKeepalive = (): void => {
    clearKeepalive();
    keepaliveTimeout = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        scheduleKeepalive();
        return;
      }

      try {
        socket.send(KEEPALIVE_PAYLOAD);
        scheduleKeepalive();
      } catch (error) {
        clearKeepalive();
        void callbacks.onError(error instanceof Error ? error.message : `websocket keepalive failed for workspace ${workspaceId}`);
        socket.close();
      }
    }, KEEPALIVE_IDLE_MS);
  };

  socket.addEventListener("open", () => {
    if (socket.protocol !== protocol) {
      void callbacks.onError(`websocket protocol rejected for workspace ${workspaceId}`);
      socket.close();
      return;
    }
    scheduleKeepalive();
  });

  socket.addEventListener("message", async (event) => {
    scheduleKeepalive();
    try {
      const payload = JSON.parse(String(event.data)) as { type: string; currentCursor?: number; event?: SyncEnvelope; reason?: string; secretId?: string; readAt?: string };
      if (payload.type === "secret_read" && payload.secretId && payload.readAt) {
        await callbacks.onSecretRead?.(payload.secretId, payload.readAt);
        return;
      }
      if (payload.type === "ack") {
        await callbacks.onAck(payload.currentCursor ?? 0);
        return;
      }
      if (payload.type === "event" && payload.event) {
        await callbacks.onEvent(payload.event);
        return;
      }
      if (payload.type === "resync_required") {
        await callbacks.onResyncRequired(payload.reason ?? "resync required");
      }
    } catch (error) {
      await callbacks.onError(error instanceof Error ? error.message : "failed to process websocket message");
    }
  });

  socket.addEventListener("error", () => {
    clearKeepalive();
    void callbacks.onError(`websocket error for workspace ${workspaceId}`);
  });

  socket.addEventListener("close", () => {
    clearKeepalive();
    void callbacks.onClose();
  });

  return () => {
    clearKeepalive();
    socket.close();
  };
}

function buildWebsocketUrl(backendUrl: string, workspaceId: string): string {
  const base = new URL(backendUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/sync/ws";
  base.searchParams.set("workspaceId", workspaceId);
  return base.toString();
}
