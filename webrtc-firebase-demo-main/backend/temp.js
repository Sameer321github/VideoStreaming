import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import { DeepgramClient } from "@deepgram/sdk";

const deepgram = new DeepgramClient(process.env.DEEPGRAM_API_KEY);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend working");
});



const DEBATE_OPTIONS = {
  model: "nova-2",
  language: "en-US",
  smart_format: true,
  punctuate: true,
  paragraphs: false,  // keep flat for live transcript display
  utterances: false,
  filler_words: false,
};

// ─── Per-socket audio buffer store ─────────────────────────────────────────
// Structure: audioBuffers[socketId][speaker] = Buffer[]
const audioBuffers = {};

async function transcribeBuffer(chunks, socketId, speaker, round) {
  if (!chunks || chunks.length === 0) return;

  // Concatenate all received chunks into one Buffer
  const combined = Buffer.concat(chunks);

  console.log(`🎙️ Transcribing ${speaker} (round ${round}) — ${combined.length} bytes`);

  try {
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      combined,
      { ...DEBATE_OPTIONS, mimetype: "audio/webm" }
    );

    if (error) {
      console.error("Deepgram error:", error.message);
      return;
    }

    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

    if (!transcript || transcript.trim() === "") {
      console.log(`⚠️ Empty transcript for ${speaker} round ${round}`);
      return;
    }

    console.log(`✅ Transcript [${speaker} R${round}]: ${transcript}`);

    // Emit back to that specific socket
    io.to(socketId).emit("transcript", {
      speaker,  // "speaker1" or "speaker2"
      round,
      text: transcript,
    });

  } catch (err) {
    console.error("Transcription failed:", err.message);
  }
}

// ─── Socket.IO ─────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Init buffer store for this socket
  audioBuffers[socket.id] = {};

  // Frontend emits this for every ~3s chunk during a speaker's turn
  // payload: { speaker: "speaker1"|"speaker2", round: number, chunk: ArrayBuffer }
  socket.on("audio:chunk", ({ speaker, round, chunk }) => {
    if (!speaker || !chunk) return;

    const key = `${speaker}_${round}`;
    if (!audioBuffers[socket.id][key]) {
      audioBuffers[socket.id][key] = [];
    }

    audioBuffers[socket.id][key].push(Buffer.from(chunk));
    console.log(`📦 Received chunk: ${speaker} R${round} — ${chunk.byteLength} bytes`);
  });

  // Frontend emits this when a speaker's turn ends (timer ran out or "End Argument")
  // payload: { speaker: "speaker1"|"speaker2", round: number }
  socket.on("turn:end", async ({ speaker, round }) => {
    if (!speaker) return;

    const key = `${speaker}_${round}`;
    const chunks = audioBuffers[socket.id]?.[key];

    console.log(`🔔 Turn ended: ${speaker} R${round}`);

    // Transcribe whatever was buffered
    await transcribeBuffer(chunks, socket.id, speaker, round);

    // Clear buffer for this turn
    if (audioBuffers[socket.id]) {
      delete audioBuffers[socket.id][key];
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    delete audioBuffers[socket.id];
  });
});

httpServer.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on ${process.env.PORT || 3000}`);
});