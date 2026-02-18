import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const PEER_JOIN_TIMEOUT_MS = Number.parseInt(process.env.PEER_JOIN_TIMEOUT_MS ?? "45000", 10);
const HEARTBEAT_INTERVAL_MS = Number.parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? "30000", 10);

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map();
/** @type {WeakMap<import('ws').WebSocket, { roomId?: string, isAlive: boolean, joinTimeout?: NodeJS.Timeout }>} */
const clients = new WeakMap();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Convenience static file serving for local testing.
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    import("node:fs/promises").then(async (fs) => {
      const html = await fs.readFile(new URL("./index.html", import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    }).catch(() => {
      res.writeHead(500);
      res.end("Failed to load index.html");
    });
    return;
  }

  if (req.method === "GET" && (req.url === "/signaling.js" || req.url === "/transport.js")) {
    import("node:fs/promises").then(async (fs) => {
      const fileUrl = new URL(`.${req.url}`, import.meta.url);
      const js = await fs.readFile(fileUrl, "utf8");
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(js);
    }).catch(() => {
      res.writeHead(404);
      res.end("Not found");
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws);
  });
});

function send(ws, message) {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function createError(type, message, roomId) {
  return {
    type,
    roomId,
    payload: { message },
  };
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  return rooms.get(roomId);
}

function removeFromRoom(ws) {
  const state = clients.get(ws);
  if (!state?.roomId) {
    return;
  }

  const room = rooms.get(state.roomId);
  if (!room) {
    return;
  }

  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(state.roomId);
    return;
  }

  for (const peer of room) {
    send(peer, {
      type: "peer-left",
      roomId: state.roomId,
      payload: {},
    });
  }
}

function relay(ws, type, roomId, payload) {
  const room = rooms.get(roomId);
  if (!room || !room.has(ws)) {
    send(ws, createError("error", "Client not joined to this room", roomId));
    return;
  }

  for (const peer of room) {
    if (peer === ws) {
      continue;
    }

    send(peer, {
      type,
      roomId,
      payload,
    });
  }
}

function clearJoinTimeout(ws) {
  const state = clients.get(ws);
  if (!state?.joinTimeout) {
    return;
  }

  clearTimeout(state.joinTimeout);
  state.joinTimeout = undefined;
}

function handleJoin(ws, roomId) {
  if (typeof roomId !== "string" || roomId.trim().length === 0) {
    send(ws, createError("error", "Invalid roomId", roomId));
    return;
  }

  const state = clients.get(ws);
  if (state?.roomId) {
    send(ws, createError("error", "Client already joined a room", state.roomId));
    return;
  }

  const room = getOrCreateRoom(roomId);
  if (room.size >= 2) {
    send(ws, createError("room-full", "Room already has 2 peers", roomId));
    return;
  }

  room.add(ws);

  const role = room.size === 1 ? "offerer" : "answerer";
  state.roomId = roomId;

  send(ws, {
    type: "joined",
    roomId,
    payload: {
      role,
      peerCount: room.size,
    },
  });

  for (const peer of room) {
    if (peer === ws) {
      continue;
    }

    send(peer, {
      type: "peer-joined",
      roomId,
      payload: {
        peerCount: room.size,
      },
    });
  }

  if (room.size === 1) {
    state.joinTimeout = setTimeout(() => {
      const currentRoom = rooms.get(roomId);
      if (!currentRoom || !currentRoom.has(ws) || currentRoom.size > 1) {
        return;
      }
      send(ws, {
        type: "peer-timeout",
        roomId,
        payload: {
          message: "No peer joined before timeout",
          timeoutMs: PEER_JOIN_TIMEOUT_MS,
        },
      });
    }, PEER_JOIN_TIMEOUT_MS);
  } else {
    clearJoinTimeout(ws);
    for (const peer of room) {
      clearJoinTimeout(peer);
    }
  }

  console.info(`[room:${roomId}] joined, peers=${room.size}`);
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

wss.on("connection", (ws) => {
  clients.set(ws, { isAlive: true });

  ws.on("pong", () => {
    const state = clients.get(ws);
    if (!state) {
      return;
    }
    state.isAlive = true;
  });

  ws.on("message", (raw) => {
    const data = parseMessage(raw);
    if (!data || typeof data.type !== "string") {
      send(ws, createError("error", "Invalid message format"));
      return;
    }

    const { type, roomId, payload } = data;

    switch (type) {
      case "join":
        handleJoin(ws, roomId);
        break;
      case "offer":
      case "answer":
      case "ice-candidate":
        relay(ws, type, roomId, payload ?? {});
        break;
      default:
        send(ws, createError("error", `Unsupported type: ${type}`, roomId));
    }
  });

  ws.on("close", () => {
    clearJoinTimeout(ws);
    removeFromRoom(ws);
    clients.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error", err);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const state = clients.get(ws);
    if (!state) {
      continue;
    }

    if (!state.isAlive) {
      ws.terminate();
      continue;
    }

    state.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.info(`Signaling server listening on http://${HOST}:${PORT}`);
  console.info(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
});
