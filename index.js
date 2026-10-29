const express = require("express");
const app = express();
const http = require("http");
const https = require("https");
const cors = require("cors");
const { Server } = require("socket.io");
app.use(cors());

// media (images, video, audio, voice notes) travels through the socket as
// binary, so the default 1MB packet limit is raised to fit a 20MB file
const MAX_PACKET_BYTES = 25 * 1024 * 1024;

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: MAX_PACKET_BYTES,
});
app.get("/", (req, res, next) => {
  res.send("<h1>iam working :-)</h1>");
});

// ICE servers for calls. STUN alone fails behind most mobile carriers, so
// when CF_TURN_KEY_ID / CF_TURN_API_TOKEN are set we hand out short-lived
// Cloudflare TURN credentials that relay the call when a direct path is blocked.
const FALLBACK_ICE = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];
const TURN_TTL_SECONDS = 24 * 60 * 60;
// reuse credentials for half their lifetime so a call never outlives them
const TURN_REUSE_MS = (TURN_TTL_SECONDS / 2) * 1000;
let turnCache = { iceServers: null, fetchedAt: 0 };

const fetchTurnServers = () =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ ttl: TURN_TTL_SECONDS });
    const req = https.request(
      {
        hostname: "rtc.live.cloudflare.com",
        path: `/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Cloudflare TURN responded ${res.statusCode}`));
          }
          try {
            const { iceServers } = JSON.parse(raw);
            // browsers block port 53, so those URLs only add a timeout
            resolve(
              iceServers.map((server) => ({
                ...server,
                urls: [].concat(server.urls).filter((url) => !/:53(\?|$)/.test(url)),
              }))
            );
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Cloudflare TURN timed out")));
    req.on("error", reject);
    req.end(body);
  });

app.get("/ice-servers", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!process.env.CF_TURN_KEY_ID || !process.env.CF_TURN_API_TOKEN) {
    return res.json({ iceServers: FALLBACK_ICE, relay: false });
  }
  if (turnCache.iceServers && Date.now() - turnCache.fetchedAt < TURN_REUSE_MS) {
    return res.json({ iceServers: turnCache.iceServers, relay: true });
  }
  try {
    const iceServers = await fetchTurnServers();
    turnCache = { iceServers, fetchedAt: Date.now() };
    res.json({ iceServers, relay: true });
  } catch (err) {
    console.error("TURN credentials failed:", err.message);
    res.json({ iceServers: FALLBACK_ICE, relay: false });
  }
});

const roomSize = (room) => io.sockets.adapter.rooms.get(room)?.size || 0;

const emitPresence = (room) => {
  io.to(room).emit("room_users", { room, count: roomSize(room) });
};

// voice/video calls are peer to peer (WebRTC); the server only tracks who is
// in each room's call and relays the offers, answers and ICE candidates
const calls = new Map(); // room -> { kind, startedBy, startedAt, participants: Map(socketId -> info) }

const callState = (room) => {
  const call = calls.get(room);
  if (!call) return { room, active: false, participants: [] };
  return {
    room,
    active: true,
    kind: call.kind,
    startedBy: call.startedBy,
    startedAt: call.startedAt,
    participants: [...call.participants].map(([id, info]) => ({ id, ...info })),
  };
};

const emitCallState = (room) => io.to(room).emit("call:state", callState(room));

const leaveCall = (socket, room = socket.data.room) => {
  const call = room && calls.get(room);
  if (!call || !call.participants.has(socket.id)) return;
  call.participants.delete(socket.id);
  for (const id of call.participants.keys()) {
    io.to(id).emit("call:peer-left", { id: socket.id });
  }
  if (call.participants.size === 0) calls.delete(room);
  emitCallState(room);
};

io.on("connection", (socket) => {
  console.log(`User Connected:${socket.id}`);

  // older clients send just the room id, newer ones send { room, username }
  socket.on("join_room", (data) => {
    const room = typeof data === "string" ? data : data?.room;
    const username = typeof data === "string" ? undefined : data?.username;
    if (!room) return;

    socket.join(room);
    socket.data.room = room;
    socket.data.username = username;
    console.log(`User With Id:${socket.id} Joined Room:${room}`);

    if (username) {
      socket.to(room).emit("user_event", { type: "joined", username });
    }
    emitPresence(room);
    // late joiners should see a call that is already running
    socket.emit("call:state", callState(room));
  });

  socket.on("call:join", (data, ack) => {
    const room = socket.data.room;
    const reply = typeof ack === "function" ? ack : () => {};
    if (!room) return reply({ error: "Join a room first" });

    let call = calls.get(room);
    const isNew = !call;
    if (isNew) {
      call = {
        kind: data?.kind === "video" ? "video" : "audio",
        startedBy: socket.data.username,
        startedAt: Date.now(),
        participants: new Map(),
      };
      calls.set(room, call);
    }
    // whoever joins sends the offers, so hand back everyone already here
    const existing = [...call.participants].map(([id, info]) => ({ id, ...info }));
    call.participants.set(socket.id, {
      username: socket.data.username,
      muted: !!data?.muted,
      cameraOff: !!data?.cameraOff,
      screen: false,
    });
    reply({ participants: existing });

    if (isNew) {
      socket.to(room).emit("call:ring", {
        username: socket.data.username,
        kind: call.kind,
      });
    }
    emitCallState(room);
  });

  socket.on("call:signal", ({ to, data } = {}) => {
    const call = calls.get(socket.data.room);
    if (!call?.participants.has(socket.id) || !call.participants.has(to)) return;
    io.to(to).emit("call:signal", { from: socket.id, data });
  });

  socket.on("call:media", (data = {}) => {
    const room = socket.data.room;
    const info = calls.get(room)?.participants.get(socket.id);
    if (!info) return;
    info.muted = !!data.muted;
    info.cameraOff = !!data.cameraOff;
    info.screen = !!data.screen;
    emitCallState(room);
  });

  socket.on("call:decline", () => {
    const room = socket.data.room;
    const call = calls.get(room);
    if (!call) return;
    for (const id of call.participants.keys()) {
      io.to(id).emit("call:declined", { username: socket.data.username });
    }
  });

  socket.on("call:leave", () => leaveCall(socket));

  socket.on("send_message", (data, ack) => {
    socket.to(data.room).emit("receive_massage", data);
    if (typeof ack === "function") ack({ ok: true });
    console.log(
      `[${data.room}] ${data.author}: ${data.type || "text"}`,
      data.type && data.type !== "text" ? data.name || "" : data.message
    );
  });

  socket.on("typing", (data) => {
    if (!data?.room) return;
    socket.to(data.room).emit("typing", {
      author: data.author,
      isTyping: !!data.isTyping,
      recording: !!data.recording,
    });
  });

  socket.on("leave_room", () => {
    const { room, username } = socket.data;
    if (!room) return;
    leaveCall(socket, room);
    socket.leave(room);
    socket.data.room = undefined;
    if (username) {
      socket.to(room).emit("user_event", { type: "left", username });
    }
    emitPresence(room);
  });

  socket.on("disconnecting", () => {
    const { room, username } = socket.data;
    if (!room) return;
    leaveCall(socket, room);
    if (username) {
      socket.to(room).emit("user_event", { type: "left", username });
    }
    // the socket is still counted while disconnecting
    socket.to(room).emit("room_users", { room, count: roomSize(room) - 1 });
  });

  socket.on("disconnect", () => {
    console.log("User Disconnect", socket.id);
  });
});

// starting the server in port:3001 (Render provides PORT)
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log("SERVER IS RUNNING");
});
