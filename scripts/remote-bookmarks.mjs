#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const CLIENT_ID_HEADER = "X-Client-Id";
const SYNC_EVENT_ID_HEADER = "X-Sync-Event-Id";
const SYNC_BASE_CURSOR_HEADER = "X-Sync-Base-Cursor";
const SYNC_CURSOR_HEADER = "X-Sync-Cursor";
const SYNC_DUPLICATE_HEADER = "X-Sync-Duplicate";

const DEFAULT_SESSION_FILE = process.env.SBS_SESSION_FILE ?? path.join(os.tmpdir(), "shared-bookmark-sync-session.json");

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === "help" || args.help) {
    printHelp();
    return;
  }

  switch (command) {
    case "register":
      await registerCommand(args);
      return;
    case "login":
      await loginCommand(args);
      return;
    case "create-folder":
      await createFolderCommand(args);
      return;
    case "create-bookmark":
      await createBookmarkCommand(args);
      return;
    case "get-tree":
      await getTreeCommand(args);
      return;
    case "replay":
      await replayCommand(args);
      return;
    case "listen-ws":
      await listenWsCommand(args);
      return;
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

async function registerCommand(args) {
  const backendUrl = requireArg(args, "backend-url");
  const email = requireArg(args, "email");
  const password = requireArg(args, "password");
  const name = args.name ?? "Admin";
  const deviceName = args["device-name"] ?? "Remote Bookmark Debug Script";
  const clientId = args["client-id"] ?? `debug-script-${randomUUID()}`;

  const session = await requestJSON(backendUrl, "/auth/register", {
    method: "POST",
    headers: {
      [CLIENT_ID_HEADER]: clientId,
    },
    body: {
      email,
      password,
      name,
      deviceName,
    },
  });

  const sessionFile = resolveSessionFile(args);
  await saveSession(sessionFile, { backendUrl, session });

  printJSON({
    ok: true,
    command: "register",
    backendUrl,
    sessionFile,
    clientId: session.clientId,
    expiresAt: session.expiresAt,
    user: session.user,
  });
}

async function loginCommand(args) {
  const backendUrl = requireArg(args, "backend-url");
  const email = requireArg(args, "email");
  const password = requireArg(args, "password");
  const deviceName = args["device-name"] ?? "Remote Bookmark Debug Script";
  const clientId = args["client-id"] ?? `debug-script-${randomUUID()}`;

  const session = await requestJSON(backendUrl, "/auth/login", {
    method: "POST",
    headers: {
      [CLIENT_ID_HEADER]: clientId,
    },
    body: {
      email,
      password,
      deviceName,
    },
  });

  const sessionFile = resolveSessionFile(args);
  await saveSession(sessionFile, { backendUrl, session });

  printJSON({
    ok: true,
    command: "login",
    backendUrl,
    sessionFile,
    clientId: session.clientId,
    expiresAt: session.expiresAt,
    user: session.user,
  });
}

async function createFolderCommand(args) {
  const { backendUrl, session } = await loadSession(args);
  const workspaceId = requireArg(args, "workspace-id");
  const name = requireArg(args, "name");
  const parentId = args["parent-id"] ?? null;
  const position = parseOptionalInt(args.position, "position");
  const baseCursor = parseBaseCursor(args);

  const response = await requestRaw(backendUrl, `/workspaces/${workspaceId}/folders`, {
    method: "POST",
    headers: mutationHeaders(session, baseCursor),
    body: {
      parentId,
      name,
      position,
    },
  });

  printJSON({
    ok: true,
    command: "create-folder",
    workspaceId,
    ack: parseAck(response),
    resource: await response.json(),
  });
}

async function createBookmarkCommand(args) {
  const { backendUrl, session } = await loadSession(args);
  const workspaceId = requireArg(args, "workspace-id");
  const folderId = requireArg(args, "folder-id");
  const title = requireArg(args, "title");
  const url = requireArg(args, "url");
  const position = parseOptionalInt(args.position, "position");
  const baseCursor = parseBaseCursor(args);

  const response = await requestRaw(backendUrl, `/workspaces/${workspaceId}/bookmarks`, {
    method: "POST",
    headers: mutationHeaders(session, baseCursor),
    body: {
      folderId,
      title,
      url,
      position,
    },
  });

  printJSON({
    ok: true,
    command: "create-bookmark",
    workspaceId,
    ack: parseAck(response),
    resource: await response.json(),
  });
}

async function getTreeCommand(args) {
  const { backendUrl, session } = await loadSession(args);
  const workspaceId = requireArg(args, "workspace-id");
  const tree = await requestAuthenticatedJSON(backendUrl, session, `/workspaces/${workspaceId}/tree`);
  printJSON(tree);
}

async function replayCommand(args) {
  const { backendUrl, session } = await loadSession(args);
  const workspaceId = requireArg(args, "workspace-id");
  const afterCursor = parseOptionalInt(args["after-cursor"] ?? "0", "after-cursor") ?? 0;
  const pathname = new URL("/sync/events", backendUrl);
  pathname.searchParams.set("workspaceId", workspaceId);
  pathname.searchParams.set("afterCursor", String(afterCursor));
  const replay = await requestAuthenticatedJSON(backendUrl, session, `${pathname.pathname}${pathname.search}`);
  printJSON(replay);
}

async function listenWsCommand(args) {
  const { backendUrl, session } = await loadSession(args);
  const workspaceId = requireArg(args, "workspace-id");
  await listenWorkspaceSocket(backendUrl, session, workspaceId);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (value === undefined || value === true || value === "") {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function parseOptionalInt(value, label) {
  if (value === undefined || value === true) {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for --${label}: ${value}`);
  }
  return parsed;
}

function parseBaseCursor(args) {
  return parseOptionalInt(args["base-cursor"] ?? "0", "base-cursor") ?? 0;
}

function resolveSessionFile(args) {
  return path.resolve(String(args["session-file"] ?? DEFAULT_SESSION_FILE));
}

async function loadSession(args) {
  const sessionFile = resolveSessionFile(args);
  const payload = JSON.parse(await readFile(sessionFile, "utf8"));
  if (!payload.backendUrl || !payload.session?.accessToken || !payload.session?.clientId) {
    throw new Error(`Invalid session file: ${sessionFile}`);
  }
  return payload;
}

async function saveSession(sessionFile, payload) {
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function mutationHeaders(session, baseCursor) {
  return {
    ...authHeaders(session),
    [SYNC_EVENT_ID_HEADER]: randomUUID(),
    [SYNC_BASE_CURSOR_HEADER]: String(baseCursor),
    "Content-Type": "application/json",
  };
}

function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    [CLIENT_ID_HEADER]: session.clientId,
  };
}

async function requestAuthenticatedJSON(backendUrl, session, pathname, init = {}) {
  return requestJSON(backendUrl, pathname, {
    ...init,
    headers: {
      ...authHeaders(session),
      ...(init.headers ?? {}),
    },
  });
}

async function requestJSON(backendUrl, pathname, init) {
  const response = await requestRaw(backendUrl, pathname, init);
  return response.json();
}

async function requestRaw(backendUrl, pathname, init) {
  const url = new URL(pathname, backendUrl).toString();
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "Content-Type": "application/json",
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    const detail = error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`Request failed ${pathname}: ${detail}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed (${response.status} ${response.statusText}) ${pathname}: ${body}`);
  }

  return response;
}

function parseAck(response) {
  return {
    eventId: response.headers.get(SYNC_EVENT_ID_HEADER),
    cursor: response.headers.get(SYNC_CURSOR_HEADER),
    duplicate: response.headers.get(SYNC_DUPLICATE_HEADER),
  };
}

function printJSON(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Remote bookmark operator script\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  node scripts/remote-bookmarks.mjs register --backend-url http://localhost:8081 --email you@example.com --password secret [--name \"Admin\"] [--device-name \"Debug Script\"] [--session-file /tmp/session.json]\n`);
  process.stdout.write(`  node scripts/remote-bookmarks.mjs login --backend-url http://localhost:8081 --email you@example.com --password secret [--device-name \"Debug Script\"] [--session-file /tmp/session.json]\n`);
  process.stdout.write(`  node scripts/remote-bookmarks.mjs create-folder --workspace-id workspace-1 --name Docs [--parent-id folder-1] [--position 0] [--base-cursor 0] [--session-file /tmp/session.json]\n`);
  process.stdout.write(`  node scripts/remote-bookmarks.mjs create-bookmark --workspace-id workspace-1 --folder-id folder-1 --title Docs --url https://example.com [--position 0] [--base-cursor 0] [--session-file /tmp/session.json]\n`);
  process.stdout.write(`  node scripts/remote-bookmarks.mjs get-tree --workspace-id workspace-1 [--session-file /tmp/session.json]\n`);
  process.stdout.write(`  node scripts/remote-bookmarks.mjs replay --workspace-id workspace-1 [--after-cursor 0] [--session-file /tmp/session.json]\n`);
  process.stdout.write(`  node scripts/remote-bookmarks.mjs listen-ws --workspace-id workspace-1 [--session-file /tmp/session.json]\n\n`);
  process.stdout.write(`The login command stores backendUrl + session JSON in ${DEFAULT_SESSION_FILE} unless --session-file is provided.\n`);
  process.stdout.write(`The diagnostic commands reuse the stored session and print formatted JSON. listen-ws stays attached until you stop it.\n`);
}

async function listenWorkspaceSocket(backendUrl, session, workspaceId) {
  const wsUrl = buildWebsocketUrl(backendUrl, workspaceId, session);
  const WebSocketImpl = globalThis.WebSocket;

  if (typeof WebSocketImpl === "function") {
    await listenWorkspaceSocketNative(WebSocketImpl, wsUrl, workspaceId);
    return;
  }

  await listenWorkspaceSocketFallback(wsUrl, workspaceId);
}

async function listenWorkspaceSocketNative(WebSocketImpl, wsUrl, workspaceId) {
  await new Promise((resolve) => {
    const socket = new WebSocketImpl(wsUrl);
    const detachSigint = bindSigint(() => socket.close(1000, "SIGINT"));
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      detachSigint();
      resolve();
    };

    socket.addEventListener("message", (event) => {
      handleSocketPayload(String(event.data));
    });

    socket.addEventListener("error", () => {
      printJSON({ type: "error", workspaceId, message: `websocket error for workspace ${workspaceId}` });
    });

    socket.addEventListener("close", (event) => {
      printJSON({ type: "close", workspaceId, code: event.code, reason: event.reason || undefined, clean: event.wasClean });
      finish();
    });
  });
}

async function listenWorkspaceSocketFallback(wsUrl, workspaceId) {
  const url = new URL(wsUrl);
  const requestFactory = url.protocol === "wss:" ? https.request : http.request;

  await new Promise((resolve) => {
    const request = requestFactory({
      protocol: url.protocol === "wss:" ? "https:" : "http:",
      hostname: url.hostname,
      port: url.port || (url.protocol === "wss:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });

    let socket = null;
    let buffer = Buffer.alloc(0);
    let settled = false;
    const detachSigint = bindSigint(() => {
      if (!socket || socket.destroyed) {
        request.destroy();
        return;
      }
      socket.write(createClientFrame(0x8));
      socket.end();
    });

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      detachSigint();
      resolve();
    };

    request.on("response", (response) => {
      printJSON({
        type: "error",
        workspaceId,
        message: `websocket upgrade failed (${response.statusCode ?? "unknown"} ${response.statusMessage ?? ""})`.trim(),
      });
      finish();
    });

    request.on("error", (error) => {
      printJSON({ type: "error", workspaceId, message: error.message });
      finish();
    });

    request.on("upgrade", (_response, upgradedSocket, head) => {
      socket = upgradedSocket;

      const consumeChunk = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const frame = readWebSocketFrame(buffer);
          if (!frame) {
            return;
          }
          buffer = buffer.subarray(frame.bytesRead);

          if (frame.opcode === 0x9) {
            socket.write(createClientFrame(0xA, frame.payload));
            continue;
          }

          if (frame.opcode === 0x8) {
            const { code, reason } = parseCloseFrame(frame.payload);
            printJSON({ type: "close", workspaceId, code, reason });
            socket.end();
            finish();
            return;
          }

          if (frame.opcode === 0x1) {
            handleSocketPayload(frame.payload.toString("utf8"));
            continue;
          }

          if (frame.opcode !== 0xA) {
            printJSON({ type: "error", workspaceId, message: `unsupported websocket opcode ${frame.opcode}` });
          }
        }
      };

      if (head.length > 0) {
        consumeChunk(head);
      }

      socket.on("data", consumeChunk);
      socket.on("error", (error) => {
        printJSON({ type: "error", workspaceId, message: error.message });
      });
      socket.on("end", () => {
        printJSON({ type: "close", workspaceId, reason: "socket ended" });
        finish();
      });
      socket.on("close", () => {
        finish();
      });
    });

    request.end();
  });
}

function handleSocketPayload(raw) {
  try {
    const payload = JSON.parse(raw);
    if (["ack", "event", "resync_required"].includes(payload.type)) {
      printJSON(payload);
      return;
    }
    printJSON({ type: "error", message: "unsupported websocket payload", payload });
  } catch (error) {
    printJSON({ type: "error", message: error instanceof Error ? error.message : "failed to parse websocket payload", raw });
  }
}

function buildWebsocketUrl(backendUrl, workspaceId, session) {
  const base = new URL(backendUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/sync/ws";
  base.searchParams.set("workspaceId", workspaceId);
  base.searchParams.set("accessToken", session.accessToken);
  base.searchParams.set("clientId", session.clientId);
  return base.toString();
}

function bindSigint(handler) {
  const onSigint = () => {
    handler();
  };
  process.once("SIGINT", onSigint);
  return () => process.off("SIGINT", onSigint);
}

function readWebSocketFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) {
      return null;
    }
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (buffer.length < offset + payloadLength) {
    return null;
  }

  return {
    opcode,
    payload: buffer.subarray(offset, offset + payloadLength),
    bytesRead: offset + payloadLength,
  };
}

function createClientFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const header = [];
  header.push(0x80 | (opcode & 0x0f));

  if (body.length < 126) {
    header.push(0x80 | body.length);
  } else if (body.length <= 0xffff) {
    header.push(0x80 | 126, (body.length >> 8) & 0xff, body.length & 0xff);
  } else {
    const length = BigInt(body.length);
    header.push(0x80 | 127);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      header.push(Number((length >> shift) & 0xffn));
    }
  }

  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4];
  }

  return Buffer.concat([Buffer.from(header), mask, masked]);
}

function parseCloseFrame(payload) {
  if (payload.length < 2) {
    return { code: undefined, reason: undefined };
  }
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString("utf8") || undefined,
  };
}
