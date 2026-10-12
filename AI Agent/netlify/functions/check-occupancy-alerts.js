/**
 * netlify/functions/check-occupancy-alerts.js
 * ------------------------------------------------------------------
 * Scheduled Function (jadwal di netlify.toml, tiap 15 menit).
 * Baca data import Outbound terbaru dari Firebase, hitung jumlah parcel
 * per Route (logika sama kayak tabel "Breakdown Volume & Aging Days Inner
 * Island" di outbound.html), lalu kirim alert ke grup SeaTalk kalau
 * volume route masuk salah satu tier.
 *
 * Hemat kuota: yang dicek tiap 15 menit cuma /latestImportMeta (kecil).
 * Data gede (/latestImportData) baru ditarik kalau ada import BARU.
 *
 * Anti-spam (state di Firebase /occupancyAlertState):
 *   - Alert dikirim kalau route baru masuk tier, atau tier-nya NAIK,
 *     atau hari (WIB) udah ganti, atau udah lewat REMIND_MINUTES sejak
 *     alert terakhir (dan datanya import baru).
 *   - Kalau volume turun di bawah 1.200, state di-reset.
 */

const zlib = require("zlib");
const {
  db,
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
} = require("./_seatalk-common");
const ROUTES = require("./_outbound-routes");

// ============== KONFIGURASI (ubah di sini kalau perlu) ==============
const FB_ROOT = "prDcOutboundMonitoring";
const STATE_PATH = FB_ROOT + "/occupancyAlertState";
const INCLUDE_OUTER = false;     // true = Outer Island (Kosambi 2 DC dkk) ikut dialert
const REMIND_MINUTES = 180;      // ingetin ulang kalau tier sama & udah segini lama (0 = matiin)
const MAX_IMPORT_AGE_MIN = 180;  // import yang lebih tua dari ini dianggap basi, gak dialert
const MAX_MSG_CHARS = 3500;      // batas aman panjang 1 pesan SeaTalk
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// Tier berdasarkan jumlah parcel (batas bawah INKLUSIF: 2.000 masuk tier 2).
const TIERS = [
  { level: 6, min: 6000, title: "Urgent Need Additional Slot & Early Loading Segera!" },
  { level: 5, min: 5000, title: "Urgent Need Additional Slot & Early Loading Segera!" },
  { level: 4, min: 4000, title: "Urgent Need Early Loading Segera!" },
  { level: 3, min: 3000, title: "Urgent Need Early Loading Segera!" },
  { level: 2, min: 2000, title: "Need Early Loading Segera!" },
  { level: 1, min: 1200, title: "Need Early Loading!" },
];

function getTier(total) {
  return TIERS.find((t) => total >= t.min) || null;
}

function agingLabel(days) {
  if (days <= 0) return "D-Day";
  if (days >= 6) return "D-6+";
  return "D-" + days;
}

function wibDayNumber(date) {
  // jumlah hari sejak epoch untuk tanggal kalender WIB
  return Math.floor((date.getTime() + WIB_OFFSET_MS) / 86400000);
}

function todayWibStr() {
  return new Date(Date.now() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

function fromColumnar(c) {
  if (!c || !c.fields || !c.length) return [];
  const rows = new Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const row = {};
    for (const f of c.fields) row[f] = c.columns[f][i];
    rows[i] = row;
  }
  return rows;
}

function slugKey(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 120);
}

// Hitung aging dari jam packing (zona WIB) biar akurat walau import udah agak lama.
function agingDaysOf(row, todayDay) {
  if (row.completeDateObj) {
    const d = new Date(row.completeDateObj);
    if (!isNaN(d)) return Math.max(0, todayDay - wibDayNumber(d));
  }
  return Number(row.agingDays) || 0;
}

function aggregate(rows) {
  const todayDay = wibDayNumber(new Date());
  const routes = ROUTES.map((r) => ({ label: r.label, hubs: r.hubs, total: 0, maxAging: 0, category: "Inner" }));
  const outer = {};

  rows.forEach((row) => {
    const aging = agingDaysOf(row, todayDay);
    const route = routes.find((r) => r.hubs.includes(row.receiverName));
    if (route) {
      route.total++;
      if (aging > route.maxAging) route.maxAging = aging;
    } else if (INCLUDE_OUTER) {
      const name = row.receiverName || "Unknown Hub";
      if (!outer[name]) outer[name] = { label: name, total: 0, maxAging: 0, category: "Outer" };
      outer[name].total++;
      if (aging > outer[name].maxAging) outer[name].maxAging = aging;
    }
  });

  return routes.concat(Object.values(outer));
}

function buildBlock(item, tier) {
  return (
    `${tier.title}\n` +
    `Route : ${item.label}\n` +
    `Quantity Parcel : ${item.total.toLocaleString("id-ID")}\n` +
    `Longest Aging : ${agingLabel(item.maxAging)}`
  );
}

function chunkBlocks(blocks) {
  const messages = [];
  let current = "";
  blocks.forEach((b) => {
    const next = current ? current + "\n\n" + b : b;
    if (next.length > MAX_MSG_CHARS && current) {
      messages.push(current);
      current = b;
    } else {
      current = next;
    }
  });
  if (current) messages.push(current);
  return messages;
}

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;
  const meta = (await db().ref(FB_ROOT + "/latestImportMeta").get()).val();
  if (!meta || !meta.importedAt) return { statusCode: 200, body: "belum ada data import" };

  const stateSnap = (await db().ref(STATE_PATH).get()).val() || {};
  const lastProcessed = stateSnap._meta && stateSnap._meta.lastImportedAt;
  if (lastProcessed === meta.importedAt) {
    return { statusCode: 200, body: "import belum berubah" };
  }

  const ageMin = (Date.now() - new Date(meta.importedAt).getTime()) / 60000;
  if (ageMin > MAX_IMPORT_AGE_MIN) {
    await db().ref(STATE_PATH + "/_meta").update({ lastImportedAt: meta.importedAt });
    return { statusCode: 200, body: `import basi (${Math.round(ageMin)} menit), dilewati` };
  }

  // Tarik & urai data gede (gzip + base64 + columnar, sama kayak di outbound.html)
  const dataGz = (await db().ref(FB_ROOT + "/latestImportData/dataGz").get()).val();
  if (!dataGz) return { statusCode: 200, body: "data import kosong" };
  const rows = fromColumnar(JSON.parse(zlib.gunzipSync(Buffer.from(dataGz, "base64")).toString("utf8")));

  const items = aggregate(rows);
  const today = todayWibStr();
  const now = Date.now();

  const toAlert = [];
  const stateUpdates = {};

  items.forEach((item) => {
    const key = slugKey(item.label);
    const tier = getTier(item.total);
    const prev = stateSnap[key];

    if (!tier) {
      if (prev && prev.level > 0) stateUpdates[key] = { level: 0, date: today, sentAt: prev.sentAt || 0 };
      return;
    }

    const isNewDay = !prev || prev.date !== today;
    const isRise = !prev || tier.level > (prev.level || 0);
    const needRemind = REMIND_MINUTES > 0 && prev && now - (prev.sentAt || 0) >= REMIND_MINUTES * 60000;

    if (isNewDay || isRise || needRemind) {
      toAlert.push({ item, tier, key });
    } else if (tier.level !== prev.level) {
      // tier turun tapi masih di atas 1.200: catat aja, gak perlu alert
      stateUpdates[key] = { level: tier.level, date: today, sentAt: prev.sentAt || 0 };
    }
  });

  if (toAlert.length) {
    toAlert.sort((a, b) => b.item.total - a.item.total);
    const messages = chunkBlocks(toAlert.map((a) => buildBlock(a.item, a.tier)));
    const token = await getSeatalkAccessToken();
    for (const text of messages) {
      await sendSeatalkGroupMessage(token, groupId, text);
    }
    toAlert.forEach((a) => {
      stateUpdates[a.key] = { level: a.tier.level, date: today, sentAt: now };
    });
  }

  const updates = {};
  Object.keys(stateUpdates).forEach((k) => { updates[`${STATE_PATH}/${k}`] = stateUpdates[k]; });
  updates[`${STATE_PATH}/_meta`] = { lastImportedAt: meta.importedAt };
  await db().ref().update(updates);

  return { statusCode: 200, body: `alert terkirim untuk ${toAlert.length} route` };
};
