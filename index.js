const express = require("express");
const app = express();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
app.get("/", (req, res, next) => {
  res.send("<h1>iam working :-)</h1>");
});

io.on("connection", (socket) => {
  console.log(`User Connected:${socket.id}`);

  socket.on("join_room", (data) => {
    socket.join(data);
    console.log(`User With Id:${socket.id} Joined Room:${data}`);
  });
  socket.on("send_message", (data) => {
    socket.to(data.room).emit("receive_massage", data);
    console.log(data);
  });

  socket.on("disconnect", () => {
    console.log("User Disconnect", socket.id);
  });
});

// starting the server in port:3001
server.listen(3001, () => {
  console.log("SERVER IS RUNNING");
});
