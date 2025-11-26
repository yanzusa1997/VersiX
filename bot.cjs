const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const fs = require("fs");
const path = require("path");

// ============== CONFIG ==============
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uSUQiOiI2OGU3ZjUwMWRkOTdmYTFhZjA1ZDIwMTUiLCJ1c2Vyc0lEIjoiNjNmZDRmNGI1MzFhYjVjZTUwMmUzOGMyIiwiaWF0IjoxNzYzODc3MTA5LCJleHAiOjE3NjUwNzcxMDl9.GgXzvQknYIFkOOjsHhr20oqcrhdaOxqrs_UX6zvYQtc"; // ganti tokenmu
const API_BASE = "https://chainers.io/api/farm";

const LOG_DIR = path.resolve(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "bot.log");

// Rotation config:
// jika true -> pakai seedMap (seed per bed berdasarkan index bed yang di-return oleh API)
// jika false -> pakai seedPool (pool yang di-rotate per bed menggunakan pointer per bed)
const MAP_PER_BED = false;

// Jika MAP_PER_BED = true, isi seedMap sesuai jumlah bed (string|null) e.g.
// const seedMap = ["seedIdBed0", "seedIdBed1", null]; // null = skip bed
const seedMap = [
    "68e1e574db32e281619c9dd5", // uncommon Beds
    "69082d2083bb86c63ef8dda9", // common Beds 1
    "690d54d183bb86c63e5233df"  // common Beds 2
  // contoh kosong — isi jika MAP_PER_BED true
];

// Jika MAP_PER_BED = false, pakai seedPool (pool seed), bot akan rotasi per bed
const seedPool = [
  "67dc227a59b878f195998e24", // sweet potato
  "673e0c942c7bfd708b35245f", // peas
  "673e0c942c7bfd708b352441"  // common strawberry
    // "673e0c942c7bfd708b35244d" // Rare strawberry
];

// Max retry untuk menunggu seed active
const WAIT_MAX_RETRY = 5;
const WAIT_MISSING_RETRY_LIMIT = 3;

// Anti-ban / delays
const ACTION_DELAY_MIN_MS = 800;   // minimal delay antar aksi (ms)
const ACTION_DELAY_MAX_MS = 1800;  // maksimal delay antar aksi (ms)
const ON_ERROR_BACKOFF_BASE_MS = 5000; // base backoff on error
const MAX_BACKOFF_MS = 120000;

// Telegram notification (opsional) — kosongkan untuk non-aktif
const TELEGRAM_BOT_TOKEN = "7659283008:AAHSh1dj6nFtRZ8hLvKKAfA0pgCwCGi09fE"; // "123456:ABC-DEF..."
const TELEGRAM_CHAT_ID = "873796129";   // chat id atau channel id

// Logging level: "info" | "warn" | "error" | "debug"
const LOG_LEVEL = "info";

// =====================================

// ensure logs dir
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// simple logger append ke file & console
function logToFile(line) {
  const ts = new Date().toISOString();
  const text = `[${ts}] ${line}\n`;
  fs.appendFile(LOG_FILE, text, (err) => {
    if (err) console.error("Unable to write log:", err.message);
  });
}
function log(level, ...args) {
  const msg = args.join(" ");
  console.log(`[${level}]`, msg);
  logToFile(`[${level}] ${msg}`);
}

// send telegram message (if configured)
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    log("warn", "Telegram send failed:", err.message);
  }
}

// helper random delay between actions to mimic human
function randDelay(min = ACTION_DELAY_MIN_MS, max = ACTION_DELAY_MAX_MS) {
  const ms = min + Math.floor(Math.random() * (max - min + 1));
  return new Promise((r) => setTimeout(r, ms));
}

// sleep util
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// API helpers
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json", authorization: AUTH_TOKEN },
  });
  const data = await res.json();
  return data;
}
async function apiPost(path, bodyObj) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: AUTH_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });
  return await res.json();
}

async function getGardens() {
  const data = await apiGet("/user/gardens");
  if (!data.success) throw new Error("Gagal ambil garden: " + (data.error || "unknown"));
  return data.data[0];
}

async function getInventory() {
  const data = await apiGet("/user/inventory?sort=lastUpdated&itemType=all&sortDirection=-1&skip=0&limit=0");
  if (!data.success) throw new Error("Gagal ambil inventory: " + (data.error || "unknown"));
  return data.data.items;
}

async function harvestSeed(userFarmingID, bedID) {
  const res = await apiPost("/control/collect-harvest", { userFarmingID });
  if (!res.success) {
    log("error", `Harvest gagal bed ${bedID}:`, res.error || JSON.stringify(res));
    return false;
  }
  const harvest = res.data.harvest?.[0];
  if (harvest) {
    log("info", `Harvest bed ${bedID}: ${harvest.type} x${harvest.count}`);
    await sendTelegram(`✅ Harvest bed ${bedID}: ${harvest.type} x${harvest.count}`);
  } else {
    log("warn", `Harvest bed ${bedID}: kosong atau tidak ada hasil`);
  }
  return true;
}

/**
 * waitForSeed with bounded retries and skip logic
 * returns: "active" | "skip"
 */
async function waitForSeed(seedID, bed) {
  let retry = 0;

  while (retry < WAIT_MAX_RETRY) {
    const inventory = await getInventory();
    const item = inventory.find(i => i.itemID === seedID);

    // ==========================
    // 1. SEED TIDAK ADA DI INVENTORY
    // ==========================
    if (!item) {
      retry++;
      log("warn", `Seed ${seedID} tidak ada di inventory (${retry}/${WAIT_MAX_RETRY})`);

      // ➤ FIX: CEK ULANG BED, BISA JADI SEDANG TANAM!
      const garden = await getGardens();
      const freshBed = garden.placedBeds.find(b => b.userBedsID === bed.userBedsID);

      if (freshBed && freshBed.plantedSeed) {
        log("info", `Bed ${bed.userBedsID} masih sedang menanam ${freshBed.plantedSeed.seedCode} → skip planting`);
        return "skip";
      }

      // jika seed memang tidak ada → tunggu
      await sleep(10000 + Math.floor(Math.random() * 3000));
      continue;
    }

    // ====================================
    // 2. SEED ADA, TAPI BELUM ACTIVE
    // ====================================
    if (item.inventoryType !== "active") {
      retry++;
      log("info", `Seed ${item.itemCode} status ${item.inventoryType} (${retry}/${WAIT_MAX_RETRY}). Menunggu aktif...`);
      await sleep(15000 + Math.floor(Math.random() * 15000));
      continue;
    }

    // ==================
    // 3. SEED SIAP!
    // ==================
    log("info", `Seed ${item.itemCode} sudah ACTIVE`);
    return "active";
  }

  // ==========
  // GAGAL
  // ==========
  log("error", `Seed ${seedID} tidak aktif setelah ${WAIT_MAX_RETRY} percobaan → skip`);
    await sendTelegram(`⛔ Seed ${seedID} tidak aktif setelah ${WAIT_MAX_RETRY} percobaan. Skip menanam.`);
  return "skip";
}

async function plantSeed(userGardensID, userBedsID, seedID) {
  try {
    const status = await waitForSeed(seedID, userBedsID);
      if (status === "skip") return null; // jangan paksa tanam

    // random small delay sebelum request untuk anti-ban
    await randDelay();

    const res = await apiPost("/control/plant-seed", { userGardensID, userBedsID, seedID });
    if (!res.success) {
      log("error", `Gagal tanam bed ${userBedsID} seed ${seedID}: ${res.error || JSON.stringify(res)}`);
      // jika error karena bed not empty, kita skip menanam (handle di caller)
      return null;
    }
    log("info", `Tanam sukses bed ${userBedsID} seed ${res.data.seedCode}`);
    return {
      bedID: userBedsID,
      userFarmingID: res.data.userFarmingID,
      growthTime: res.data.growthTime,
      plantedAt: Date.now(),
      seedCode: res.data.seedCode
    };
  } catch (err) {
    log("error", `Exception plantSeed bed ${userBedsID}: ${err.message}`);
    return null;
  }
}

// =========== rotation helpers ===========
// if MAP_PER_BED is true: seedMap expected to be an array with length >= beds.length, each entry is seedID or null
// if MAP_PER_BED is false: seedPool used and we rotate per bed using pointers
const rotationPointers = {}; // key = bedID, value = index in seedPool

function getSeedForBed(bedIndex, bedID) {
  if (MAP_PER_BED) {
    return seedMap[bedIndex] || null;
  } else {
    if (!seedPool || seedPool.length === 0) return null;
    if (!rotationPointers[bedID]) rotationPointers[bedID] = 0;
    const idx = rotationPointers[bedID] % seedPool.length;
    // advance pointer for next time this bed is planted
    rotationPointers[bedID] = (rotationPointers[bedID] + 1) % seedPool.length;
    return seedPool[idx];
  }
}

// =========== main smart loop ===========

async function processGardenOnce() {
  const garden = await getGardens();
  const gardenID = garden.userGardensID;
  const beds = garden.placedBeds;

  if (!beds || beds.length === 0) {
    log("warn", "Tidak menemukan beds di garden. Cek akun / API.");
    await sleep(30000);
    return;
  }

  let nextHarvestDeltaMs = Infinity;
  let anyAction = false;

  for (let i = 0; i < beds.length; i++) {
    const bed = beds[i];
    const bedID = bed.userBedsID;
    const planted = bed.plantedSeed; // bisa undefined jika kosong

    // pilih seed sesuai mode
    const seedForThisBed = getSeedForBed(i, bedID);

    // jika tidak ada seed mapping/pool untuk bed ini, skip
    if (!seedForThisBed) {
      log("debug", `No seed assigned for bedIndex ${i} (bed ${bedID}) - skip.`);
      continue;
    }

    if (!planted) {
      log("info", `Bed ${bedID} kosong -> mencoba tanam seed ${seedForThisBed}`);
      anyAction = true;
      const plantedRes = await plantSeed(gardenID, bedID, seedForThisBed);
      // jika plantedRes === null berarti gagal/skip, lanjut ke bed berikut
      await randDelay();
      continue;
    }

    // if planted exists -> check harvest time
    const harvestTime = new Date(planted.plantedDate).getTime() + planted.growthTime * 1000;
    const now = Date.now();

    if (now >= harvestTime) {
      log("info", `Bed ${bedID} siap panen now -> harvesting.`);
      anyAction = true;
      const ok = await harvestSeed(planted.userFarmingID, bedID);
      await randDelay();
      if (ok) {
        // try plant after successful harvest
        log("info", `Coba tanam ulang bed ${bedID} setelah panen, seed ${seedForThisBed}`);
        await plantSeed(gardenID, bedID, seedForThisBed);
      }
      await randDelay();
      continue;
    } else {
      const delta = harvestTime - now;
      if (delta < nextHarvestDeltaMs) nextHarvestDeltaMs = delta;
      log("debug", `Bed ${bedID} belum matang (${Math.ceil(delta/1000)}s lagi)`);
    }
  }

  if (!anyAction) {
    if (nextHarvestDeltaMs === Infinity) {
      // tidak ada bed yang di-handle (semua kemungkinan skip karena konfigurasi)
      log("info", "Tidak ada aksi dilakukan (mungkin semua bed tidak ter-mapped). Tidur 30s.");
      await sleep(30000);
    } else {
      // tidur sampai waktu panen terdekat, kurangi sedikit agar aman (mis. 2s)
      const sleepMs = Math.max(5000, nextHarvestDeltaMs - 2000);
      log("info", `Semua bed sedang tumbuh. Tidur ${Math.ceil(sleepMs/1000)}s sampai panen terdekat.`);
      await sleep(sleepMs);
    }
  } else {
    // ada aksi dilakukan -> quick loop small wait
    await sleep(2000 + Math.floor(Math.random() * 2000));
  }
}

// wrapper main loop with error backoff
async function startBot() {
  let errorBackoffMs = 0;
  while (true) {
    try {
      await processGardenOnce();
      // reset backoff on success
      errorBackoffMs = 0;
    } catch (err) {
      log("error", "Runtime error:", err.message);
      errorBackoffMs = Math.min(MAX_BACKOFF_MS, (errorBackoffMs === 0 ? ON_ERROR_BACKOFF_BASE_MS : errorBackoffMs * 2));
      log("info", `Backoff karena error: ${Math.ceil(errorBackoffMs/1000)}s`);
      await sleep(errorBackoffMs);
      // send notif jika banyak error
      await sendTelegram(`⚠️ Bot error: ${err.message}. Backoff ${Math.ceil(errorBackoffMs/1000)}s`);
    }
  }
}

// start
log("info", "=== FARM BOT VERSI X START ===");
startBot().catch(e => {
  log("error", "Fatal error:", e.message);
  sendTelegram(`❌ Bot fatal error: ${e.message}`);
});
