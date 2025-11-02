// === Echo App Server (Render Compatible, FINAL) ===
require("dotenv").config();
const express = require("express");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const http = require("http");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const shortid = require("shortid");

// === Initialize ===
const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://Sandydb456:Sandydb456@cluster0.o4lr4zd.mongodb.net/?appName=Cluster0";
const BASE_URL = process.env.BASE_URL || `https://sandy-echo.onrender.com`;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve everything in same folder

// === Multer ===
const upload = multer({
  storage: multer.diskStorage({
    destination: __dirname,
    filename: (req, file, cb) => cb(null, shortid.generate() + ".webm"),
  }),
});

// === MongoDB ===
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

// === Upload Voice ===
app.post("/api/upload", upload.single("voice"), async (req, res) => {
  try {
    const { privacy = "anonymous", expiry = "permanent", senderId, senderName } = req.body;
    const id = shortid.generate();
    const expireAt = expiry === "24h" ? new Date(Date.now() + 86400000) : null;

    const voice = {
      id,
      path: req.file.filename,
      privacy,
      expiry,
      senderId,
      senderName,
      createdAt: new Date(),
      expireAt,
      openCount: 0,
      playCount: 0,
      revealRequest: false,
      revealApproved: privacy === "auto_reveal",
    };

    await db.collection("voices").insertOne(voice);
    res.json({ ok: true, link: `${BASE_URL}/v/${id}` }); // 👈 Use /v/ route now
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

// === Voice APIs ===
app.get("/api/voice/:id", async (req, res) => {
  const v = await db.collection("voices").findOne({ id: req.params.id });
  if (!v) return res.status(404).json({});
  res.json(v);
});

app.get("/play/:file", (req, res) => {
  const filePath = path.join(__dirname, req.params.file);
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).send("File not found");
});

app.post("/api/open/:id", async (req, res) => {
  await db.collection("voices").updateOne({ id: req.params.id }, { $inc: { openCount: 1 } });
  res.json({ ok: true });
});

app.post("/api/play/:id", async (req, res) => {
  await db.collection("voices").updateOne({ id: req.params.id }, { $inc: { playCount: 1 } });
  res.json({ ok: true });
});

// === Reveal System ===
app.post("/api/request-reveal/:id", async (req, res) => {
  const voice = await db.collection("voices").findOne({ id: req.params.id });
  if (!voice) return res.status(404).json({ ok: false });

  await db.collection("voices").updateOne(
    { id: req.params.id },
    { $set: { revealRequest: true } }
  );

  io.to(voice.senderId).emit("reveal_request", {
    id: voice.id,
    senderId: voice.senderId,
  });

  res.json({ ok: true });
});

app.post("/api/approve-reveal/:id", async (req, res) => {
  const voice = await db.collection("voices").findOne({ id: req.params.id });
  if (!voice) return res.status(404).json({ ok: false });

  await db.collection("voices").updateOne(
    { id: req.params.id },
    { $set: { revealApproved: true } }
  );

  io.emit("reveal_approved", { id: voice.id });
  res.json({ ok: true });
});

// === Dashboard ===
app.get("/api/dashboard/:senderId", async (req, res) => {
  const data = await db
    .collection("voices")
    .find({ senderId: req.params.senderId })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(data);
});

// === Serve main index for /v/:id ===
// 👇 this is what fixes Render’s “Not Found” for shared links
app.get("/v/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// === Fallback route ===
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// === Socket.io ===
io.on("connection", (socket) => {
  console.log("🔗 Connected:", socket.id);
  socket.on("register_sender", (senderId) => {
    if (senderId) socket.join(senderId);
  });
  socket.on("disconnect", () => console.log("❌ Disconnected:", socket.id));
});

// === Start ===
server.listen(PORT, () => console.log(`🚀 Server live on ${BASE_URL}`));
