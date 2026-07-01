import type { SessionData, SyncEnvelope } from "./types.js";

export interface SyncSocketCallbacks {
  onAck: (currentCursor: number) => void | Promise<void>;
  onEvent: (event: SyncEnvelope) => void | Promise<void>;
  onResyncRequired: (reason: string) => void | Promise<void>;
  onClose: () => void | Promise<void>;
  onError: (message: string) => void | Promise<void>;
}

export function connectWorkspaceSocket(
  backendUrl: string,
  session: SessionData,
  workspaceId: string,
  callbacks: SyncSocketCallbacks,
): () => void {
  const wsUrl = buildWebsocketUrl(backendUrl, workspaceId, session);
  const socket = new WebSocket(wsUrl);

  socket.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as { type: string; currentCursor?: number; event?: SyncEnvelope; reason?: string };
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
    void callbacks.onError(`websocket error for workspace ${workspaceId}`);
  });

  socket.addEventListener("close", () => {
    void callbacks.onClose();
  });

  return () => {
    socket.close();
  };
}

function buildWebsocketUrl(backendUrl: string, workspaceId: string, session: SessionData): string {
  const base = new URL(backendUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/sync/ws";
  base.searchParams.set("workspaceId", workspaceId);
  base.searchParams.set("accessToken", session.accessToken);
  base.searchParams.set("clientId", session.clientId);
  return base.toString();
}
