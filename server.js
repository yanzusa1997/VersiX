import express from "express";
import("./bot.cjs"); // jalankan bot kamu

const app = express();
app.get("/", (req, res) => res.send("✅ Bot Chainers masih jalan!"));
app.listen(3000, () => console.log("🌐 Keep-alive server listening on port 3000"));
