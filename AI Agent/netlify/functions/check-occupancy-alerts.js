const zlib = require("zlib");
const {
  db,
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
} = require("./_seatalk-common");
const ROUTES = require("./_outbound-routes");
// NOTE: _alert-image di-require lazy di dalam try (lihat bagian kirim gambar),
// supaya kalau modul gambar bermasalah, alert teks tetap terkirim.

const SEATALK_API_BASE = "https://openapi.seatalk.io";

const FB_ROOT = "prDcOutboundMonitoring";
const STATE_PATH = FB_ROOT + "/occupancyAlertState";
const INCLUDE_OUTER = false;     // true = Outer Island (Kosambi 2 DC dkk) ikut dialert
const REMIND_MINUTES = 180;      // ingetin ulang kalau tier sama & udah segini lama (0 = matiin)
const MAX_IMPORT_AGE_MIN = 180;  // import yang lebih tua dari ini dianggap basi, gak dialert
const MAX_MSG_CHARS = 3500;      // batas aman panjang 1 pesan SeaTalk
const SEND_IMAGE = true;         // kirim gambar tabel dulu sebelum teks (false = teks aja)
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const TIERS = [
  { level: 6, min: 6000, short: "URGENT + Tambah Slot", title: "Urgent Need Additional Slot & Early Loading Segera!" },
  { level: 5, min: 5000, short: "URGENT + Tambah Slot", title: "Urgent Need Additional Slot & Early Loading Segera!" },
  { level: 4, min: 4000, short: "URGENT Early Loading", title: "Urgent Need Early Loading Segera!" },
  { level: 3, min: 3000, short: "URGENT Early Loading", title: "Urgent Need Early Loading Segera!" },
  { level: 2, min: 2000, short: "Early Loading Segera", title: "Need Early Loading Segera!" },
  { level: 1, min: 1200, short: "Need Early Loading", title: "Need Early Loading!" },
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

// Kirim gambar PNG (base64) ke grup SeaTalk.
async function sendGroupImage(accessToken, groupId, base64Png) {
  const res = await fetch(`${SEATALK_API_BASE}/messaging/v2/group_chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      group_id: groupId,
      message: { tag: "image", image: { content: base64Png } },
    }),
  });
  return res.json();
}

// SeaTalk balikin { code: 0 } kalau sukses. Kalau bukan 0, anggap gagal biar
// state "sudah dialert" gak ke-tandain padahal pesannya gak sampai.
function assertSent(result, what) {
  console.log(`[occupancy-alert] respon SeaTalk (${what}): ` + JSON.stringify(result));
  if (result && typeof result.code === "number" && result.code !== 0) {
    throw new Error(`SeaTalk nolak pesan (${what}): ` + JSON.stringify(result));
  }
}

function formatWibStamp(isoStr) {
  const d = new Date(new Date(isoStr).getTime() + WIB_OFFSET_MS);
  const bln = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agt", "Sep", "Okt", "Nov", "Des"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())} ${bln[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}.${pad(d.getUTCMinutes())} WIB`;
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

// Semua jalur keluar dicatat ke log Netlify biar kelihatan KENAPA notif gak kekirim.
function done(msg) {
  console.log("[occupancy-alert] " + msg);
  return { statusCode: 200, body: msg };
}

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;
  const meta = (await db().ref(FB_ROOT + "/latestImportMeta").get()).val();
  if (!meta || !meta.importedAt) return done("belum ada data import (latestImportMeta kosong)");

  const stateSnap = (await db().ref(STATE_PATH).get()).val() || {};
  const lastProcessed = stateSnap._meta && stateSnap._meta.lastImportedAt;
  if (lastProcessed === meta.importedAt) {
    return done(`import belum berubah (importedAt ${meta.importedAt}), sudah pernah diproses`);
  }

  const ageMin = (Date.now() - new Date(meta.importedAt).getTime()) / 60000;
  if (ageMin > MAX_IMPORT_AGE_MIN) {
    await db().ref(STATE_PATH + "/_meta").update({ lastImportedAt: meta.importedAt });
    return done(`import basi (${Math.round(ageMin)} menit > ${MAX_IMPORT_AGE_MIN}), dilewati & ditandai sudah diproses`);
  }

  // Tarik & urai data gede (gzip + base64 + columnar, sama kayak di outbound.html)
  const dataGz = (await db().ref(FB_ROOT + "/latestImportData/dataGz").get()).val();
  if (!dataGz) return done("data import kosong (latestImportData/dataGz gak ada)");
  const rows = fromColumnar(JSON.parse(zlib.gunzipSync(Buffer.from(dataGz, "base64")).toString("utf8")));

  const items = aggregate(rows);
  const top = items.slice().sort((a, b) => b.total - a.total).slice(0, 3)
    .map((i) => `${i.label}=${i.total}`).join(" | ");
  console.log(`[occupancy-alert] import ${meta.importedAt}: ${rows.length} parcel, ${items.filter((i) => i.total >= TIERS[TIERS.length - 1].min).length} route >= ${TIERS[TIERS.length - 1].min}. Top: ${top}`);
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
    if (!groupId) throw new Error("Env var SEATALK_TARGET_GROUP_ID belum diset di Netlify.");
    console.log(`[occupancy-alert] ngirim ${toAlert.length} route ke grup ...${String(groupId).slice(-6)}`);
    const token = await getSeatalkAccessToken();

    // 1) Gambar tabel dulu. Kalau gagal (termasuk modul gambar gak kebaca),
    //    jangan sampai nahan alert teks.
    if (SEND_IMAGE) {
      try {
        const { renderEarlyLoadingTable } = require("./_alert-image");
        const png = await renderEarlyLoadingTable(
          toAlert.map((a) => ({
            label: a.item.label,
            total: a.item.total,
            agingLabel: agingLabel(a.item.maxAging),
            level: a.tier.level,
            shortTitle: a.tier.short,
          })),
          {
            title: "Early Loading Alert — Palangka Raya DC",
            subtitle: `Data import: ${formatWibStamp(meta.importedAt)}  ·  ${toAlert.length} route perlu tindakan`,
          }
        );
        assertSent(await sendGroupImage(token, groupId, png), "gambar");
      } catch (err) {
        console.error("Gagal kirim gambar tabel (lanjut kirim teks):", err);
      }
    }

    // 2) Teks alert (format asli).
    for (const text of messages) {
      assertSent(await sendSeatalkGroupMessage(token, groupId, text), "teks");
    }
    toAlert.forEach((a) => {
      stateUpdates[a.key] = { level: a.tier.level, date: today, sentAt: now };
    });
  }

  const updates = {};
  Object.keys(stateUpdates).forEach((k) => { updates[`${STATE_PATH}/${k}`] = stateUpdates[k]; });
  updates[`${STATE_PATH}/_meta`] = { lastImportedAt: meta.importedAt };
  await db().ref().update(updates);

  return done(
    toAlert.length
      ? `alert terkirim untuk ${toAlert.length} route`
      : "diproses, tapi gak ada route yang perlu dialert (di bawah threshold, atau tier sama & belum waktunya remind)"
  );
};
