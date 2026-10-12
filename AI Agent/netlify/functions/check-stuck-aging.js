/**
 * netlify/functions/check-stuck-aging.js
 * ------------------------------------------------------------------
 * Alert PARCEL STUCK (aging lewat D-1) per HUB, lengkap dengan daftar
 * TO Number. Function terpisah dari check-occupancy-alerts (Early Loading),
 * punya state & interval sendiri.
 *
 * Jadwal di netlify.toml: tiap 5 menit (interval kirimnya dijaga di kode).
 */
const zlib = require("zlib");
const { db, getSeatalkAccessToken } = require("./_seatalk-common");
const ROUTES = require("./_outbound-routes");
const U = require("./_alert-utils");

const FB_ROOT = U.FB_ROOT;
const STATE_PATH = FB_ROOT + "/stuckAlertState";

const INCLUDE_OUTER = false;      // true = hub di luar daftar route (Outer Island dkk) ikut dicek
const STUCK_MIN_AGING = 3;        // aging >= 3 hari (D-3 ke atas, alias lebih dari D-2) dianggap stuck
const STUCK_MIN_PARCEL = 1;       // minimal parcel stuck per hub biar dialert
const STUCK_SHOW_TO = true;       // tampilin daftar TO Number parcel yang stuck
const STUCK_MAX_TO_PER_HUB = 20;  // maks TO Number per hub (sisanya diringkas "+N TO lainnya")
const STUCK_INTERVAL_MINUTES = 70; // jarak antar alert. 0 = alert di setiap function jalan
const INTERVAL_GRACE_MS = 2 * 60 * 1000; // toleransi biar jadwal cron 5 menit gak ngegeser ke 75 menit
const MAX_IMPORT_AGE_MIN = 180;   // import yang lebih tua dari ini dianggap basi, gak dialert
const MENTION_LEAD = `Parcel stuck lewat ${U.agingLabel(STUCK_MIN_AGING - 1)}, mohon segera ditindaklanjuti`;

// Catat parcel stuck per hub, dipecah per bucket aging (D-6 = D-6+).
function addStuck(target, aging, row) {
  target.stuck++;
  const to = row && row.toNo != null ? String(row.toNo).trim() : "";
  if (to && to !== "-") target.stuckTos.push({ to, aging });
  const k = Math.min(aging, 6);
  target.buckets[k] = (target.buckets[k] || 0) + 1;
}

// Dikelompokkan PER HUB (bukan per route gabungan).
function aggregateStuck(rows) {
  const todayDay = U.wibDayNumber(new Date());
  const knownHubs = new Set();
  ROUTES.forEach((r) => r.hubs.forEach((h) => knownHubs.add(h)));
  const hubs = {};

  rows.forEach((row) => {
    const name = String(row.receiverName || "Unknown Hub").trim();
    if (!INCLUDE_OUTER && !knownHubs.has(name)) return;
    const aging = U.agingDaysOf(row, todayDay);
    if (aging < STUCK_MIN_AGING) return;
    if (!hubs[name]) hubs[name] = { label: name, maxAging: 0, stuck: 0, buckets: {}, stuckTos: [] };
    if (aging > hubs[name].maxAging) hubs[name].maxAging = aging;
    addStuck(hubs[name], aging, row);
  });

  return Object.values(hubs);
}

function buildStuckBlock(item) {
  const breakdown = Object.keys(item.buckets)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => `${U.agingLabel(k)}: ${item.buckets[k].toLocaleString("id-ID")}`)
    .join(" | ");
  let text =
    `Parcel Stuck Aging > ${U.agingLabel(STUCK_MIN_AGING - 1)}!\n` +
    `Hub : ${item.label}\n` +
    `Quantity Stuck : ${item.stuck.toLocaleString("id-ID")}\n` +
    `Breakdown : ${breakdown}\n` +
    `Longest Aging : ${U.agingLabel(item.maxAging)}`;

  // Daftar TO Number, aging paling tua duluan.
  if (STUCK_SHOW_TO && item.stuckTos.length) {
    const sorted = item.stuckTos
      .slice()
      .sort((a, b) => b.aging - a.aging || a.to.localeCompare(b.to));
    const shown = sorted.slice(0, STUCK_MAX_TO_PER_HUB);
    text += "\nTO Number :\n" + shown.map((x) => `${x.to} (${U.agingLabel(x.aging)})`).join("\n");
    if (sorted.length > shown.length) text += `\n... +${sorted.length - shown.length} TO lainnya`;
  }
  return text;
}

// Semua jalur keluar dicatat ke log Netlify biar kelihatan KENAPA notif gak kekirim.
function done(msg) {
  console.log("[stuck-alert] " + msg);
  return { statusCode: 200, body: msg };
}

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;

  // Cek interval dulu (murah) sebelum narik data gede.
  const state = (await db().ref(STATE_PATH).get()).val() || {};
  const lastAlertAt = state.lastAlertAt || 0;
  if (STUCK_INTERVAL_MINUTES > 0) {
    const elapsed = Date.now() - lastAlertAt;
    if (elapsed < STUCK_INTERVAL_MINUTES * 60000 - INTERVAL_GRACE_MS) {
      return done(`belum waktunya alert lagi (${Math.round(elapsed / 60000)} dari ${STUCK_INTERVAL_MINUTES} menit sejak alert terakhir)`);
    }
  }

  const meta = (await db().ref(FB_ROOT + "/latestImportMeta").get()).val();
  if (!meta || !meta.importedAt) return done("belum ada data import (latestImportMeta kosong)");

  const ageMin = (Date.now() - new Date(meta.importedAt).getTime()) / 60000;
  if (ageMin > MAX_IMPORT_AGE_MIN) {
    return done(`import basi (${Math.round(ageMin)} menit > ${MAX_IMPORT_AGE_MIN}), dilewati`);
  }

  const dataGz = (await db().ref(FB_ROOT + "/latestImportData/dataGz").get()).val();
  if (!dataGz) return done("data import kosong (latestImportData/dataGz gak ada)");
  const rows = U.fromColumnar(JSON.parse(zlib.gunzipSync(Buffer.from(dataGz, "base64")).toString("utf8")));

  const stuckItems = aggregateStuck(rows)
    .filter((i) => i.stuck >= STUCK_MIN_PARCEL)
    .sort((a, b) => b.stuck - a.stuck);
  const totalStuck = stuckItems.reduce((n, i) => n + i.stuck, 0);
  console.log(`[stuck-alert] import ${meta.importedAt}: ${rows.length} parcel, stuck >= ${U.agingLabel(STUCK_MIN_AGING)}: ${stuckItems.length} hub, ${totalStuck} parcel`);

  if (!stuckItems.length) return done("gak ada parcel stuck, gak ada yang dialert");

  if (!groupId) throw new Error("Env var SEATALK_TARGET_GROUP_ID belum diset di Netlify.");
  console.log(`[stuck-alert] ngirim ${stuckItems.length} hub ke grup ...${String(groupId).slice(-6)}`);
  const token = await getSeatalkAccessToken();

  const mentionText = U.buildMentionText(MENTION_LEAD);
  const messages = U.chunkBlocks(
    stuckItems.map(buildStuckBlock),
    U.MAX_MSG_CHARS - mentionText.length - 2
  );
  // Tag + Cc ditempel di pesan terakhir (1x aja, biar gak spam notif).
  if (mentionText) messages[messages.length - 1] += "\n\n" + mentionText;
  for (const text of messages) {
    U.assertSent(await U.sendAlertText(token, groupId, text), "teks stuck");
  }

  await db().ref(STATE_PATH).update({ lastAlertAt: Date.now(), lastImportedAt: meta.importedAt });
  return done(`alert terkirim untuk ${stuckItems.length} hub (${totalStuck} parcel stuck)`);
};
