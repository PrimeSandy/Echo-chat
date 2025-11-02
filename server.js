// server.js
require("dotenv").config();
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "public/voices/" });

const BASE_URL = process.env.BASE_URL || "https://sandy-echo.onrender.com";
const DB_URL = process.env.MONGO_URL || "mongodb+srv://<your_connection_string>";
const DB_NAME = "echoApp";
let db, voices;

// Connect MongoDB
(async () => {
  const client = new MongoClient(DB_URL);
  await client.connect();
  db = client.db(DB_NAME);
  voices = db.collection("voices");
  console.log("✅ MongoDB connected");
})();

// socket.io connections
io.on("connection", (socket) => {
  console.log("🔗 Socket connected:", socket.id);

  // Register sender room
  socket.on("register_sender", (senderId) => {
    socket.join(senderId);
    console.log(`✅ Sender registered room: ${senderId}`);
  });
});

// ========== API ROUTES ==========

// Upload voice
app.post("/api/upload", upload.single("voice"), async (req, res) => {
  try {
    const { privacy, expiry, senderId, senderName } = req.body;
    const id = Math.random().toString(36).substring(2, 10);
    const voice = {
      id,
      path: req.file.filename,
      senderId,
      senderName,
      privacy,
      expiry,
      openCount: 0,
      playCount: 0,
      revealRequest: false,
      revealApproved: false,
      createdAt: new Date(),
    };
    await voices.insertOne(voice);
    res.json({ ok: true, link: `${BASE_URL}/?v=${id}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// Get dashboard
app.get("/api/dashboard/:senderId", async (req, res) => {
  const docs = await voices.find({ senderId: req.params.senderId }).toArray();
  res.json(docs);
});

// Open voice
app.post("/api/open/:id", async (req, res) => {
  await voices.updateOne({ id: req.params.id }, { $inc: { openCount: 1 } });
  res.json({ ok: true });
});

// Play voice
app.post("/api/play/:id", async (req, res) => {
  await voices.updateOne({ id: req.params.id }, { $inc: { playCount: 1 } });
  res.json({ ok: true });
});

// Get voice details
app.get("/api/voice/:id", async (req, res) => {
  const voice = await voices.findOne({ id: req.params.id });
  if (!voice) return res.status(404).json({ error: "Not found" });
  res.json(voice);
});

// Request reveal
app.post("/api/request-reveal/:id", async (req, res) => {
  const voice = await voices.findOne({ id: req.params.id });
  if (!voice) return res.status(404).json({ error: "Not found" });

  await voices.updateOne({ id: req.params.id }, { $set: { revealRequest: true } });

  // notify sender realtime
  io.to(voice.senderId).emit("reveal_request", { id: voice.id, senderId: voice.senderId });
  res.json({ ok: true });
});

// Approve reveal
app.post("/api/approve-reveal/:id", async (req, res) => {
  const voice = await voices.findOne({ id: req.params.id });
  if (!voice) return res.status(404).json({ error: "Not found" });

  await voices.updateOne(
    { id: req.params.id },
    { $set: { revealApproved: true } }
  );

  // notify receiver + include senderName
  io.emit("reveal_approved", {
    id: voice.id,
    senderName: voice.senderName || "Anonymous",
  });

  res.json({ ok: true });
});

// play file
app.get("/play/:filename", (req, res) => {
  const file = path.join(__dirname, "public/voices", req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).send("File not found");
  res.sendFile(file);
});

// fallback frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Echo server running on ${PORT}`));
