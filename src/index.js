import http from "http";
import express from "express";
import { Server } from "socket.io";
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const PORT = process.env.PORT || 3003;
const HISTORY_LIMIT = 50;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/health", (_req, res) => res.json({ status: "ok", service: "chat-service" }));

const redis = createClient({ url: REDIS_URL });
redis.on("error", (e) => console.error("Redis error", e));
await redis.connect();

io.on("connection", (socket) => {
  socket.on("join-room", async ({ roomId, name }) => {
    socket.join(roomId);
    socket.data.name = name || "Anonymous";

    const history = await redis.lRange(`chat:${roomId}`, -HISTORY_LIMIT, -1);
    socket.emit("chat-history", history.map((m) => JSON.parse(m)));
  });

  socket.on("chat-message", async ({ roomId, text }) => {
    const message = { name: socket.data.name || "Anonymous", text, ts: Date.now() };
    await redis.rPush(`chat:${roomId}`, JSON.stringify(message));
    await redis.lTrim(`chat:${roomId}`, -HISTORY_LIMIT, -1);
    io.to(roomId).emit("chat-message", message);
  });
});

server.listen(PORT, () => console.log(`chat-service listening on ${PORT}`));
