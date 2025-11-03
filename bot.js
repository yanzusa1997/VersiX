const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// === CONFIG ===
const AUTH_TOKEN =
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uSUQiOiI2OGU3ZjUwMWRkOTdmYTFhZjA1ZDIwMTUiLCJ1c2Vyc0lEIjoiNjNmZDRmNGI1MzFhYjVjZTUwMmUzOGMyIiwiaWF0IjoxNzYxMjkxNDk4LCJleHAiOjE3NjI0OTE0OTh9.OklCvPKiKvG4OPCps1w1jh0e4-p2I4ob0YwkW9xB2uA"; // token kamu
const API_BASE = "https://chainers.io/api/farm";

// isi manual sesuai jumlah plot (harus urut sama urutan bed)
const seedIDs = [
    // "673e0c942c7bfd708b352447", // uncommon strawberry
    // "673e0c942c7bfd708b35245f", // peas
    "673e0c942c7bfd708b352441", // common strawberry
    "673e0c942c7bfd708b35244d" // Rare strawberry
];

// === API Helpers ===
async function getGardens() {
    const res = await fetch(`${API_BASE}/user/gardens`, {
        headers: { accept: "application/json", authorization: AUTH_TOKEN },
    });
    const data = await res.json();
    if (!data.success)
        throw new Error("Gagal ambil garden: " + (data.error || "unknown"));
    return data.data[0];
}

async function getInventory() {
    const res = await fetch(
        `${API_BASE}/user/inventory?sort=lastUpdated&itemType=all&sortDirection=-1&skip=0&limit=0`,
        {
            headers: { accept: "application/json", authorization: AUTH_TOKEN },
        },
    );
    const data = await res.json();
    if (!data.success)
        throw new Error("Gagal ambil inventory: " + (data.error || "unknown"));
    return data.data.items;
}

async function harvestSeed(userFarmingID, bedID) {
    const res = await fetch(`${API_BASE}/control/collect-harvest`, {
        method: "POST",
        headers: {
            accept: "application/json",
            authorization: AUTH_TOKEN,
            "content-type": "application/json",
        },
        body: JSON.stringify({ userFarmingID }),
    });

    const data = await res.json();
    if (!data.success) {
        console.log(`❌ Harvest gagal di bed ${bedID}:`, data.error);
        return false;
    }

    const harvest = data.data.harvest?.[0];
    if (harvest) {
        console.log(`✅ Harvest bed ${bedID}: ${harvest.type} x${harvest.count}`);
    } else {
        console.log(`⚠️ Harvest bed ${bedID}: tidak ada hasil.`);
    }
    return true;
}

async function waitForSeed(seedID, userGardensID, beds) {
    let retry = 0;
    while (true) {
        const inventory = await getInventory();
        const item = inventory.find((i) => i.itemID === seedID);
        if (!item) {
            retry++;
            console.log(`⚠️ Seed ${seedID} tidak ada di inventory (${retry}/3)...`);
            if (retry >= 3) {
                console.log("🔁 Cek ulang kondisi bed karena seed belum tersedia...");
                const garden = await getGardens();
                await handleBeds(garden);
                retry = 0;
            }
            await new Promise((r) => setTimeout(r, 10000));
            continue;
        }

        if (item.inventoryType === "active") {
            return;
        } else {
            console.log(`⏳ Seed ${item.itemCode} belum aktif (${item.inventoryType}), tunggu 60s...`);
            await new Promise((r) => setTimeout(r, 60000));
        }
    }
}

async function plantSeed(userGardensID, bedID, seedID, beds) {
    await waitForSeed(seedID, userGardensID, beds);
    const res = await fetch(`${API_BASE}/control/plant-seed`, {
        method: "POST",
        headers: {
            accept: "application/json",
            authorization: AUTH_TOKEN,
            "content-type": "application/json",
        },
        body: JSON.stringify({ userGardensID, userBedsID: bedID, seedID }),
    });

    const data = await res.json();
    if (!data.success) {
        console.log(`❌ Gagal menanam di bed ${bedID}: ${data.error}`);
        return null;
    }

    console.log(`🌱 Tanam ${data.data.seedCode} di bed ${bedID} sukses!`);
    return {
        bedID,
        userFarmingID: data.data.userFarmingID,
        growthTime: data.data.growthTime,
        plantedAt: Date.now(),
        seedCode: data.data.seedCode,
    };
}

// === Fungsi utama per bed ===
async function handleBeds(garden) {
    const userGardensID = garden.userGardensID;
    const beds = garden.placedBeds;

    for (let i = 0; i < beds.length && i < seedIDs.length; i++) {
        const bed = beds[i];
        const seedID = seedIDs[i];
        const farming = bed.plantedSeed;

        if (farming) {
            const harvestTime =
                new Date(farming.plantedDate).getTime() + farming.growthTime * 1000;

            if (Date.now() >= harvestTime) {
                console.log(`🌾 Bed ${bed.userBedsID} siap panen.`);
                const harvested = await harvestSeed(farming.userFarmingID, bed.userBedsID);
                if (harvested) {
                    await new Promise((r) => setTimeout(r, 1000));
                    await plantSeed(userGardensID, bed.userBedsID, seedID, beds);
                }
            } else {
                const sisa = Math.floor((harvestTime - Date.now()) / 1000);
                console.log(`⏳ Bed ${bed.userBedsID} belum matang (${sisa}s lagi).`);
            }
        } else {
            console.log(`🪴 Bed ${bed.userBedsID} kosong, tanam sekarang...`);
            await plantSeed(userGardensID, bed.userBedsID, seedID, beds);
        }

        await new Promise((r) => setTimeout(r, 1000)); // delay antar bed
    }
}

// === MAIN LOOP ===
async function startBot() {
    while (true) {
        try {
            const garden = await getGardens();
            await handleBeds(garden);
            console.log("⏳ Tunggu 60 detik sebelum cek ulang...\n");
            await new Promise((r) => setTimeout(r, 60000)); // interval cek ulang
        } catch (err) {
            console.error("❌ Runtime error:", err.message);
            await new Promise((r) => setTimeout(r, 10000));
        }
    }
}

startBot();
