// server.js
require("dotenv").config();
const express = require("express");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const http = require("http");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const shortid = require("shortid");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://<your_mongo_user>:<your_pw>@cluster0.mongodb.net/?retryWrites=true&w=majority";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

// ensure public/voices exists
const VOICES_DIR = path.join(__dirname, "public", "voices");
if (!fs.existsSync(VOICES_DIR)) fs.mkdirSync(VOICES_DIR, { recursive: true });

// Multer: save to public/voices
const upload = multer({
  storage: multer.diskStorage({
    destination: VOICES_DIR,
    filename: (req, file, cb) => cb(null, shortid.generate() + ".webm"),
  }),
});

// MongoDB init
let db;
(async () => {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("EchoApp");
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
  }
})();

/**
 Thread document shape:
 {
   id: "threadId",
   senderId: "echo_xxx",         // owner
   senderName: "Sandy",
   privacy: "reveal_on_request",
   expiry: "permanent",
   createdAt: Date,
   messages: [
     { msgId, filename, createdAt, playedCount:0 }
   ],
   revealRequest: false,
   revealApproved: false
 }
*/

// Upload/append message
app.post("/api/upload", upload.single("voice"), async (req, res) => {
  try {
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready" });

    const { privacy = "anonymous", expiry = "permanent", senderId, senderName, threadId } = req.body;
    const filename = req.file.filename;
    const msg = {
      msgId: shortid.generate(),
      filename,
      createdAt: new Date(),
      playedCount: 0,
    };

    if (threadId) {
      // append to existing thread
      const thread = await db.collection("voices").findOne({ id: threadId });
      if (!thread) {
        return res.status(404).json({ ok: false, error: "Thread not found" });
      }
      await db.collection("voices").updateOne(
        { id: threadId },
        {
          $push: { messages: msg },
          $set: { senderName: senderName || thread.senderName, privacy: privacy || thread.privacy },
        }
      );
      // notify room
      io.to(`thread_${threadId}`).emit("new_message", { id: threadId, message: msg });
      return res.json({ ok: true, link: `${BASE_URL}/?v=${threadId}`, threadId });
    } else {
      // create new thread
      const id = shortid.generate();
      const thread = {
        id,
        senderId,
        senderName,
        privacy,
        expiry,
        createdAt: new Date(),
        messages: [msg],
        revealRequest: false,
        revealApproved: privacy === "auto_reveal",
      };
      await db.collection("voices").insertOne(thread);
      // notify creator's room optionally (they should already be in it)
      io.to(`sender_${senderId}`).emit("thread_created", { id: id });
      return res.json({ ok: true, link: `${BASE_URL}/?v=${id}`, threadId: id });
    }
  } catch (err) {
    console.error("upload error:", err);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

// Get thread details (including messages)
app.get("/api/voice/:id", async (req, res) => {
  try {
    const v = await db.collection("voices").findOne({ id: req.params.id });
    if (!v) return res.status(404).json({ ok: false, error: "Not found" });
    res.json(v);
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// Serve audio file
app.get("/play/:file", (req, res) => {
  const filePath = path.join(VOICES_DIR, req.params.file);
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  return res.status(404).send("File not found");
});

// Increment open
app.post("/api/open/:id", async (req, res) => {
  await db.collection("voices").updateOne({ id: req.params.id }, { $inc: { openCount: 1 } });
  res.json({ ok: true });
});

// Increment play for a specific message inside messages[]
app.post("/api/play/:id/:msgId", async (req, res) => {
  await db.collection("voices").updateOne(
    { id: req.params.id, "messages.msgId": req.params.msgId },
    { $inc: { "messages.$.playedCount": 1 } }
  );
  res.json({ ok: true });
});

// Reveal request
app.post("/api/request-reveal/:id", async (req, res) => {
  const voice = await db.collection("voices").findOne({ id: req.params.id });
  if (!voice) return res.status(404).json({ ok: false });
  await db.collection("voices").updateOne({ id: req.params.id }, { $set: { revealRequest: true } });
  // notify owner (use senderId room)
  io.to(`sender_${voice.senderId}`).emit("reveal_request", { id: voice.id, senderId: voice.senderId });
  res.json({ ok: true });
});

// Approve reveal (emit to thread room so receivers see name)
app.post("/api/approve-reveal/:id", async (req, res) => {
  const voice = await db.collection("voices").findOne({ id: req.params.id });
  if (!voice) return res.status(404).json({ ok: false });
  await db.collection("voices").updateOne({ id: req.params.id }, { $set: { revealApproved: true } });
  // emit to thread room
  io.to(`thread_${voice.id}`).emit("reveal_approved", { id: voice.id, senderName: voice.senderName || "Anonymous" });
  res.json({ ok: true });
});

// Dashboard (threads for sender)
app.get("/api/dashboard/:senderId", async (req, res) => {
  const data = await db
    .collection("voices")
    .find({ senderId: req.params.senderId })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(data);
});

// Serve front-end
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/v/:id", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Socket.io connections
io.on("connection", (socket) => {
  console.log("🔗 socket connected:", socket.id);

  // Sender can join a sender room to get notifications about new thread creation / reveal requests
  socket.on("register_sender", (senderId) => {
    if (senderId) {
      socket.join(`sender_${senderId}`);
      console.log(`socket ${socket.id} joined sender_${senderId}`);
    }
  });

  // Receiver/viewer will join the thread room to get live new messages / reveal approvals
  socket.on("join_thread", (threadId) => {
    if (threadId) {
      socket.join(`thread_${threadId}`);
      console.log(`socket ${socket.id} joined thread_${threadId}`);
    }
  });

  socket.on("disconnect", () => {
    // cleanup logged automatically
  });
});

// Start server
server.listen(PORT, () => console.log(`🚀 Server running at ${BASE_URL}`));

