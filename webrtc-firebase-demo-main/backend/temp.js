import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import { createClient } from "@deepgram/sdk";
dotenv.config();
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);



const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("Backend working"));

// // ─── Deepgram ──────────────────────────────────────────────────────────────
// const deepgram = new DeepgramClient(process.env.DEEPGRAM_API_KEY);

const DEBATE_OPTIONS = {
  model: "nova-2",
  language: "en-US",
  smart_format: true,
  punctuate: true,
  paragraphs: false,
  utterances: false,
  filler_words: false,
};

async function transcribeBuffer(chunks, speaker, round, roomId) {
  if (!chunks || chunks.length === 0) return;
  const combined = Buffer.concat(chunks);
  console.log(`🎙️ Transcribing ${speaker} R${round} — ${combined.length} bytes`);
  try {
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
  combined,
  DEBATE_OPTIONS
);

if (error) { console.error("Deepgram error:", error); return; }

const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
if (!transcript?.trim()) { console.log(`⚠️ Empty transcript: ${speaker} R${round}`); return; }

console.log(`✅ [${speaker} R${round}]: ${transcript}`);
io.to(roomId).emit("transcript", { speaker, round, text: transcript });

  } catch (err) {
    console.error("Transcription failed:", err.message);
  }
}

// ─── Audio buffers ─────────────────────────────────────────────────────────
const audioBuffers = {};

// ─── Socket.IO ─────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  audioBuffers[socket.id] = {};

  // ── WebRTC signaling ────────────────────────────────────────────────────

  // Caller creates a room and gets a room ID back
  socket.on("create:room", () => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "caller";
    socket.emit("room:created", roomId);
    console.log(`Room created: ${roomId}`);
  });

  // Answerer joins existing room
  socket.on("join:room", (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) {
      socket.emit("room:error", "Room not found");
      return;
    }
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "answerer";
    // Tell caller that someone joined so they can send the offer
    socket.to(roomId).emit("peer:joined");
    console.log(`${socket.id} joined room: ${roomId}`);
  });

  // Relay WebRTC offer from caller to answerer
  socket.on("webrtc:offer", (offer) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("webrtc:offer", offer);
  });

  // Relay WebRTC answer from answerer to caller
  socket.on("webrtc:answer", (answer) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("webrtc:answer", answer);
  });

  // Relay ICE candidates
  socket.on("webrtc:ice", (candidate) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("webrtc:ice", candidate);
  });

  // ── Debate phase sync ───────────────────────────────────────────────────
  socket.on("debate:phase", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("debate:phase", payload);
  });

  // ── Audio transcription ─────────────────────────────────────────────────
  socket.on("audio:chunk", ({ speaker, round, chunk }) => {
    if (!speaker || !chunk) return;
    const key = `${speaker}_${round}`;
    if (!audioBuffers[socket.id][key]) audioBuffers[socket.id][key] = [];
    audioBuffers[socket.id][key].push(Buffer.from(chunk));
    console.log(`📦 Chunk: ${speaker} R${round} — ${chunk.byteLength} bytes`);
  });

  socket.on("turn:end", async ({ speaker, round }) => {
    if (!speaker) return;
    const key = `${speaker}_${round}`;
    const chunks = audioBuffers[socket.id]?.[key];
    const roomId = socket.data.roomId;
    console.log(`🔔 Turn ended: ${speaker} R${round}`);
    await transcribeBuffer(chunks, speaker, round, roomId);
    if (audioBuffers[socket.id]) delete audioBuffers[socket.id][key];
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    delete audioBuffers[socket.id];
  });
});

httpServer.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on ${process.env.PORT || 3000}`);
});