const express = require("express");
const app = express();
const http = require("http");
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

const roomSize = (room) => io.sockets.adapter.rooms.get(room)?.size || 0;

const emitPresence = (room) => {
  io.to(room).emit("room_users", { room, count: roomSize(room) });
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
  });

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
