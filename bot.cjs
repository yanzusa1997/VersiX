const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// === CONFIG ===
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uSUQiOiI2OGU3ZjUwMWRkOTdmYTFhZjA1ZDIwMTUiLCJ1c2Vyc0lEIjoiNjNmZDRmNGI1MzFhYjVjZTUwMmUzOGMyIiwiaWF0IjoxNzYzODc3MTA5LCJleHAiOjE3NjUwNzcxMDl9.GgXzvQknYIFkOOjsHhr20oqcrhdaOxqrs_UX6zvYQtc";
const API_BASE = "https://chainers.io/api/farm";
const REQ_TOKEN = "9a7c210a88af797a"; // NEW REQUIRED

// Sesuaikan urutan bed (bed[0] pakai seedIDs[0])
const seedIDs = [
    "673e0c942c7bfd708b352441",
    "673e0c942c7bfd708b35244d",
    "673e0c942c7bfd708b35245f",
];

// === HEADERS ===
function apiHeaders() {
    return {
        accept: "application/json",
        authorization: AUTH_TOKEN,
        "content-type": "application/json",
        "x-request-token-id": REQ_TOKEN,
    };
}

// === HELPERS ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// === API ===
async function safeFetch(url, options, retry = 0) {
    const res = await fetch(url, options);
    const data = await res.json();

    if (data?.error === "Rate limit exceeded") {
        console.log("⛔ Rate limit! Pause 5–8 detik...");
        await sleep(5000 + Math.random() * 3000);
        return safeFetch(url, options, retry + 1);
    }

    return data;
}

async function getGardens() {
    const url = `${API_BASE}/user/gardens`;
    const data = await safeFetch(url, { headers: apiHeaders() });

    if (!data.success) throw new Error("Gagal get garden: " + data.error);
    return data.data[0];
}

async function getInventory() {
    const url = `${API_BASE}/user/inventory?sort=lastUpdated&itemType=all&sortDirection=-1`;
    const data = await safeFetch(url, { headers: apiHeaders() });

    if (!data.success) throw new Error("Gagal get inventory: " + data.error);
    return data.data.items;
}

// === HARVEST ===
async function harvestSeed(userFarmingID, bedID) {
    const url = `${API_BASE}/control/collect-harvest`;
    const data = await safeFetch(url, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ userFarmingID }),
    });

    if (!data.success) {
        console.log(`❌ Harvest gagal di ${bedID}:`, data.error);
        return false;
    }

    const h = data.data.harvest?.[0];
    console.log(`✅ Harvest ${bedID}: ${h?.type} x${h?.count || 0}`);
    return true;
}

// === LOGIC WAITING SEED (ANTI LOOPING) ===
async function waitForSeed(seedID, bedID, garden) {
    let retry = 0;

    while (retry < 6) {
        // 1️⃣ CEK DARI GARDEN – JIKA SUDAH DITANAM, STOP!!
        const bed = garden.placedBeds.find((b) => b.userBedsID === bedID);

        if (bed?.plantedSeed?.seedID === seedID) {
            console.log(`🟢 Seed ${seedID} sedang ditanam di bed ${bedID} → tidak perlu cek inventory`);
            return "already-planted";
        }

        // 2️⃣ CEK INVENTORY
        const inventory = await getInventory();
        const item = inventory.find((i) => i.itemID === seedID);

        if (!item) {
            retry++;
            console.log(`⚠️ Seed ${seedID} hilang (${retry}/6)… cek garden lagi…`);
            await sleep(4000);
            garden = await getGardens();
            continue;
        }

        if (item.inventoryType === "active") {
            console.log(`🟢 Seed ${seedID} aktif`);
            return "active";
        }

        console.log(`⏳ Seed ${seedID} (status=${item.inventoryType}), tunggu aktif…`);
        retry++;
        await sleep(6000 + Math.random() * 4000);
    }

    console.log(`⛔ Seed ${seedID} tidak aktif setelah 6x cek.`);
    return "not-active";
}

// === PLANT ===
async function plantSeed(garden, bedID, seedID) {
    // CEK & TUNGGU SEED
    const wait = await waitForSeed(seedID, bedID, garden);
    if (wait === "not-active") return false;

    const url = `${API_BASE}/control/plant-seed`;
    const data = await safeFetch(url, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({
            userGardensID: garden.userGardensID,
            userBedsID: bedID,
            seedID,
        }),
    });

    if (!data.success) {
        console.log(`❌ Tanam gagal di ${bedID}:`, data.error);
        return false;
    }

    console.log(`🌱 Tanam ${data.data.seedCode} → bed ${bedID}`);
    return true;
}

// === MAIN BED HANDLER ===
async function handleBeds(garden) {
    const beds = garden.placedBeds;

    for (let i = 0; i < beds.length && i < seedIDs.length; i++) {
        const bed = beds[i];
        const seedID = seedIDs[i];

        const planted = bed.plantedSeed;

        // Jika ada tanaman
        if (planted) {
            const finish =
                new Date(planted.plantedDate).getTime() +
                planted.growthTime * 1000;

            if (Date.now() >= finish) {
                console.log(`🌾 Bed ${bed.userBedsID} siap panen`);
                const ok = await harvestSeed(planted.userFarmingID, bed.userBedsID);
                if (ok) await plantSeed(garden, bed.userBedsID, seedID);
            } else {
                const sisa = Math.round((finish - Date.now()) / 1000);
                console.log(`⌛ Bed ${bed.userBedsID}: belum matang (${sisa}s)`);
            }
        } else {
            console.log(`🪴 Bed ${bed.userBedsID} kosong → tanam`);
            await plantSeed(garden, bed.userBedsID, seedID);
        }

        await sleep(500); // delay antar bed
    }
        // === Hitung next wake time ===
    let nextWake = 999999; // default sangat besar

    for (let i = 0; i < beds.length && i < seedIDs.length; i++) {
        const bed = beds[i];
        const farming = bed.plantedSeed;

        if (!farming) continue; // bed kosong tidak dihitung

        const harvestTime =
            new Date(farming.plantedDate).getTime() + farming.growthTime * 1000;

        const sisa = Math.floor((harvestTime - Date.now()) / 1000);
        if (sisa > 0 && sisa < nextWake) nextWake = sisa;
    }

    if (nextWake === 999999) {
        console.log("🌙 Semua bed kosong / baru panen → sleep default 30 detik.\n");
        return 30;
    }

    console.log(`😴 Sleep sampai bed terdekat matang (${nextWake}s)...\n`);
    return nextWake + 3; // buffer 3 detik

}

// === MAIN LOOP ===
async function startBot() {
    while (true) {
        try {
            const garden = await getGardens();
            const nextSleep = await handleBeds(garden);

            console.log(`⏳ Sleep ${nextSleep}s\n`);
            await new Promise(r => setTimeout(r, nextSleep * 1000));

        } catch (err) {
            console.error("❌ Runtime error:", err.message);
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}
startBot();
