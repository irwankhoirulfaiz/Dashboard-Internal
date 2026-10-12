/**
 * _seatalk-common.js
 * ------------------------------------------------------------------
 * Helper bersama dipakai oleh seatalk-webhook.js, check-low-stock.js,
 * check-ops-alerts.js & daily-briefing.js. File ini BUKAN endpoint
 * sendiri (gak diawali handler), jadi Netlify gak akan nge-generate
 * URL publik buat file ini — aman ditaruh di folder functions yang
 * sama.
 *
 * ISI (per modul dashboard):
 *   - Inventory Control (Stock)          -> getStockItems / answerInventoryQuestion
 *   - Inbound (LH Tracking)              -> getInboundTrips / answerInboundQuestion
 *   - Outbound Monitoring (Aging)        -> getOutboundRows / answerOutboundQuestion
 *   - Rest Time & Asset Usage (PDA)      -> getRestAssetData / answerRestTimeQuestion
 *   - Performance Bagger                 -> getTodayBaggerRecords / answerPerformanceBaggerQuestion
 *   - Router lintas modul                -> answerModuleQuestion (dipanggil dari seatalk-webhook.js)
 *
 * Logika hitung status/alert di sini SENGAJA niru PERSIS fungsi yang
 * sama di dashboard (inbound.html, outbound.html) & report-agent.html
 * (Odyssey) — biar jawaban bot selalu konsisten sama yang ditampilin
 * dashboard, bukan ngitung ulang dengan cara sendiri.
 */

const admin = require("firebase-admin");
const zlib = require("zlib");

const SEATALK_API_BASE = "https://openapi.seatalk.io";

// ================= FIREBASE ADMIN INIT =================
// Env var FIREBASE_SERVICE_ACCOUNT_JSON diisi ISI MENTAH file JSON service
// account (Firebase Console > Project Settings > Service Accounts >
// Generate new private key) - copy-paste langsung isinya, gak perlu
// di-encode base64 dulu.
function getFirebaseApp() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("Env var FIREBASE_SERVICE_ACCOUNT_JSON belum diset.");
  }
  const serviceAccount = JSON.parse(raw);

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL, // contoh: https://xxx-default-rtdb.asia-southeast1.firebasedatabase.app
  });
}

function db() {
  return getFirebaseApp().database();
}

// ================= HELPER TANGGAL (WIB) =================
// Netlify Functions jalan di UTC, sedangkan semua workingDate/tanggal di
// dashboard dicatat pakai jam lokal WIB (UTC+7). Geser manual biar "hari
// ini" versi bot cocok sama "hari ini" versi dashboard.
function nowWIB() {
  return new Date(Date.now() + 7 * 3600000);
}
function todayStr() {
  return nowWIB().toISOString().slice(0, 10);
}

// ================= SEATALK BOT API =================

async function getSeatalkAccessToken() {
  const res = await fetch(`${SEATALK_API_BASE}/auth/app_access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: process.env.SEATALK_APP_ID,
      app_secret: process.env.SEATALK_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.app_access_token) {
    throw new Error("Gagal ambil access token SeaTalk: " + JSON.stringify(data));
  }
  return data.app_access_token;
}

async function sendSeatalkGroupMessage(accessToken, groupId, text) {
  const res = await fetch(`${SEATALK_API_BASE}/messaging/v2/group_chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      group_id: groupId,
      message: { tag: "text", text: { content: text } },
    }),
  });
  return res.json();
}

async function sendSeatalkPrivateMessage(accessToken, employeeCode, text) {
  const res = await fetch(`${SEATALK_API_BASE}/messaging/v2/single_chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      employee_code: employeeCode,
      message: { tag: "text", text: { content: text } },
    }),
  });
  return res.json();
}

// ================= INVENTORY CONTROL (Stock) =================
// NOTE: masih hardcode facility "SOC" (sama kayak check-low-stock.js yang
// udah jalan). Kalau nanti mau multi-facility, tinggal parameterisasi ini.

async function getStockItems() {
  const snap = await db().ref("inventoryControl/SOC/stock").get();
  const stock = snap.val() || {};
  return Object.entries(stock).map(([id, val]) => ({ id, ...val }));
}

async function answerInventoryQuestion(text) {
  const lower = text.toLowerCase();
  if (!/stock|consumable|menipis|low stock/.test(lower)) return null;

  const items = await getStockItems();
  if (!items.length) return "Belum ada data Stock di Inventory Control.";

  if (lower.includes("consumable")) {
    const consumables = items.filter((it) =>
      (it.category || "").toLowerCase().includes("consumable")
    );
    if (!consumables.length) return "Gak ada Asset dengan kategori Consumable di Stock.";
    const lines = consumables.map((it) => `• ${it.name}: ${it.qty} ${it.unit || "pcs"}`);
    return `Stock Consumable saat ini:\n${lines.join("\n")}`;
  }

  if (lower.includes("menipis") || lower.includes("low stock")) {
    const low = items.filter((it) => Number(it.qty) <= Number(it.minStock ?? 0));
    if (!low.length) return "Gak ada Asset yang stock-nya menipis 👍";
    const lines = low.map(
      (it) => `• ${it.name}: sisa ${it.qty} ${it.unit || "pcs"} (Min: ${it.minStock})`
    );
    return `Asset dengan stock menipis:\n${lines.join("\n")}`;
  }

  const lines = items
    .slice(0, 20)
    .map((it) => `• ${it.name}: ${it.qty} ${it.unit || "pcs"}`);
  return `Daftar Stock Asset:\n${lines.join("\n")}${items.length > 20 ? "\n…dan lainnya" : ""}`;
}

// ================= INBOUND (LH Tracking) =================
const INBOUND_LH_PATH = "prDcInboundTracking/lhTracking";
const INBOUND_LATE_THRESHOLD_HOURS = 6.5;
const INBOUND_EARLY_THRESHOLD_HOURS = 6.0;

// Niru PERSIS computeStatus() di inbound.html / report-agent.html.
function computeTripStatus(t) {
  const std = t.stdOrigin ? new Date(t.stdOrigin) : null;
  const sta = t.staDest ? new Date(t.staDest) : null;
  const ata = t.ataDest ? new Date(t.ataDest) : null;

  if (ata) {
    if (!std) return "-";
    const durationHours = (ata - std) / 3600000;
    if (durationHours < INBOUND_EARLY_THRESHOLD_HOURS) return "Early Arrived";
    if (durationHours <= INBOUND_LATE_THRESHOLD_HOURS) return "On Time";
    return "Late Arrival";
  }
  return sta && nowWIB() > sta ? "Late Arrival" : "In Transit";
}

async function getInboundTrips() {
  const snap = await db().ref(INBOUND_LH_PATH).get();
  const val = snap.val() || {};
  return Object.keys(val).map((k) => {
    const t = Object.assign({ _key: k }, val[k]);
    t.statusText = computeTripStatus(t);
    return t;
  });
}

function isTripToday(t) {
  const d = t.tanggal || (t.stdOrigin ? String(t.stdOrigin).slice(0, 10) : null);
  return d === todayStr();
}

async function answerInboundQuestion(text) {
  const lower = text.toLowerCase();
  if (!/\blate\b|telat|transit|\btrip\b|inbound|lh tracking|forecast/.test(lower)) return null;

  const trips = await getInboundTrips();
  if (!trips.length) return "Belum ada data LH Tracking di Inbound.";
  const todayTrips = trips.filter(isTripToday);

  if (lower.includes("late") || lower.includes("telat")) {
    const late = todayTrips.filter((t) => t.statusText === "Late Arrival");
    if (!late.length) return "Gak ada trip Late Arrival hari ini 👍";
    const lines = late.slice(0, 15).map((t) => `• ${t.tripNum} (${t.routeName}) - ${t.vendorName}`);
    return `🔴 Trip Late Arrival hari ini (${late.length}):\n${lines.join("\n")}${late.length > 15 ? "\n…dan lainnya" : ""}`;
  }

  if (lower.includes("transit")) {
    const transit = todayTrips.filter((t) => t.statusText === "In Transit");
    if (!transit.length) return "Gak ada trip In Transit saat ini.";
    const lines = transit.slice(0, 15).map((t) => `• ${t.tripNum} (${t.routeName}) - ETA ${t.etaDestStr || t.staDest || "-"}`);
    return `🟡 Trip In Transit (${transit.length}):\n${lines.join("\n")}${transit.length > 15 ? "\n…dan lainnya" : ""}`;
  }

  const counts = { "Late Arrival": 0, "On Time": 0, "Early Arrived": 0, "In Transit": 0 };
  todayTrips.forEach((t) => { counts[t.statusText] = (counts[t.statusText] || 0) + 1; });
  return (
    `Ringkasan Inbound hari ini (${todayTrips.length} trip):\n` +
    `• 🔴 Late Arrival: ${counts["Late Arrival"]}\n` +
    `• 🟢 On Time: ${counts["On Time"]}\n` +
    `• 🔵 Early Arrived: ${counts["Early Arrived"]}\n` +
    `• 🟡 In Transit: ${counts["In Transit"]}`
  );
}

// ================= OUTBOUND MONITORING (Aging Backlog) =================
// CATATAN KETERBATASAN: outbound.html nyimpen data import di Firebase dalam
// format COLUMNAR + GZIP base64 (field "dataGz") biar payload gede (puluhan
// ribu parcel) tetep hemat. Bot ini bisa decompress & baca row mentahnya
// (Node.js zlib kompatibel sama gzip yang dipakai browser CompressionStream
// di outbound.html), TAPI perhitungan "Occupancy %" di dashboard butuh
// setting kapasitas per-destination yang cuma kesimpen di localStorage
// BROWSER (bukan Firebase) — jadi itu BELUM BISA dijawab bot sampai
// settingnya dipindah ke database. Yang reliable dihitung dari data mentah:
// total parcel & jumlah backlog kritis (aging D-3 ke atas) secara total.

function fromColumnar(columnar) {
  if (!columnar || !columnar.fields || !columnar.length) return [];
  const { fields, length, columns } = columnar;
  const rows = new Array(length);
  for (let i = 0; i < length; i++) {
    const row = {};
    for (let f = 0; f < fields.length; f++) row[fields[f]] = columns[fields[f]][i];
    rows[i] = row;
  }
  return rows;
}

async function getOutboundRows() {
  const snap = await db().ref("prDcOutboundMonitoring/latestImportData").get();
  const payload = snap.val();
  if (!payload || !payload.dataGz) return [];
  const jsonStr = zlib.gunzipSync(Buffer.from(payload.dataGz, "base64")).toString("utf8");
  const columnar = JSON.parse(jsonStr);
  return fromColumnar(columnar);
}

async function answerOutboundQuestion(text) {
  const lower = text.toLowerCase();
  if (!/aging|backlog|occupancy|staging/.test(lower)) return null;

  if (lower.includes("occupancy") || lower.includes("staging")) {
    return "Data Occupancy staging area belum bisa dijawab bot ya — settingnya (kapasitas per destination) masih kesimpen di browser, belum di database. Cek langsung di dashboard Outbound Monitoring dulu.";
  }

  const rows = await getOutboundRows();
  if (!rows.length) return "Belum ada data import Outbound Monitoring.";

  const danger = rows.filter((r) => Number(r.agingDays) >= 3);
  return (
    `📦 Ringkasan Aging Backlog Outbound (data import terakhir):\n` +
    `• Total Parcel: ${rows.length}\n` +
    `• 🔴 Backlog Kritis (D-3 ke atas): ${danger.length}`
  );
}

// ================= REST TIME & ASSET USAGE (PDA) =================
const MON_ROOT = "prDcMonitoring";
const MON_WINDOW_DAYS = 3; // disamain kayak window di rest-time.html/report-agent.html

// Niru PERSIS parseDateTime di rest-time.html (format "YYYY-MM-DD HH:mm:ss", lokal WIB).
function monParseDateTime(str) {
  if (!str) return null;
  const t = String(str).split(/[- :]/);
  return new Date(t[0], t[1] - 1, t[2], t[3] || 0, t[4] || 0, t[5] || 0);
}

function getMonWindowStartDate() {
  const d = nowWIB();
  d.setDate(d.getDate() - MON_WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
}

async function getRestAssetData() {
  const startDate = getMonWindowStartDate();
  const [logsSnap, assetSnap, masterSnap, stationSnap] = await Promise.all([
    db().ref(MON_ROOT + "/logs").orderByChild("workingDate").startAt(startDate).get(),
    db().ref(MON_ROOT + "/assetLogs").orderByChild("workingDate").startAt(startDate).get(),
    db().ref(MON_ROOT + "/master").get(),
    db().ref(MON_ROOT + "/pdaStationMap").get(),
  ]);
  const logsVal = logsSnap.val() || {};
  const assetVal = assetSnap.val() || {};
  return {
    logs: Object.keys(logsVal).map((k) => Object.assign({ _key: k }, logsVal[k])),
    assetLogs: Object.keys(assetVal).map((k) => Object.assign({ _key: k }, assetVal[k])),
    master: masterSnap.val() || {},
    stationMap: stationSnap.val() || {},
  };
}

// Niru PERSIS computeRestAssetLiveStatus() di report-agent.html (Odyssey),
// yang sendirinya niru checkRestOvertimeAlert()/getActiveAssetLock() di
// rest-time.html.
function computeRestAssetLiveStatus(logs, assetLogs, master, stationMap) {
  const now = nowWIB();

  // --- Operator yang lagi Break Out & udah >60 menit ---
  const byOpsRest = {};
  logs.forEach((l) => { (byOpsRest[l.opsId] = byOpsRest[l.opsId] || []).push(l); });
  const operatorIstirahatLebih60Menit = [];
  Object.keys(byOpsRest).forEach((opsId) => {
    const arr = byOpsRest[opsId].slice().sort((a, b) => monParseDateTime(a.timestamp) - monParseDateTime(b.timestamp));
    const last = arr[arr.length - 1];
    if (last && last.breakType === "Break Out") {
      const breakOutTime = monParseDateTime(last.timestamp);
      const durasiMenit = Math.floor((now - breakOutTime) / 60000);
      if (durasiMenit > 60) {
        const u = master[opsId] || {};
        operatorIstirahatLebih60Menit.push({
          opsId, nama: u.name || "(tanpa nama)", dept: u.dept || "-", agency: u.agency || "-",
          jamBreakOut: last.timestamp, durasiMenit,
        });
      }
    }
  });
  operatorIstirahatLebih60Menit.sort((a, b) => b.durasiMenit - a.durasiMenit);

  // --- PDA yang aksi terakhirnya "Pinjam PDA" (belum "Kembali PDA") ---
  const byAssetSn = {};
  assetLogs.forEach((l) => { (byAssetSn[l.serialNumber] = byAssetSn[l.serialNumber] || []).push(l); });
  const pdaBelumKembali = [];
  Object.keys(byAssetSn).forEach((sn) => {
    const arr = byAssetSn[sn].slice().sort((a, b) => monParseDateTime(a.timestamp) - monParseDateTime(b.timestamp));
    const last = arr[arr.length - 1];
    if (last && last.action === "Pinjam PDA") {
      const u = master[last.opsId] || {};
      const pinjamTime = monParseDateTime(last.timestamp);
      pdaBelumKembali.push({
        station: stationMap[sn] || "(station tidak diketahui)", serialNumber: sn,
        opsId: last.opsId, namaPeminjam: u.name || "(tanpa nama)", jamPinjam: last.timestamp,
        durasiJam: Number(((now - pinjamTime) / 3600000).toFixed(1)),
      });
    }
  });

  return { operatorIstirahatLebih60Menit, pdaBelumKembali };
}

async function answerRestTimeQuestion(text) {
  const lower = text.toLowerCase();
  if (!/\bpda\b|istirahat|\bbreak\b|check ?in|check ?out|rest time/.test(lower)) return null;

  const data = await getRestAssetData();
  const status = computeRestAssetLiveStatus(data.logs, data.assetLogs, data.master, data.stationMap);

  if (lower.includes("pda") && !lower.includes("istirahat")) {
    if (!status.pdaBelumKembali.length) return "Semua PDA udah kembali, gak ada yang lagi dipinjam kelamaan 👍";
    const lines = status.pdaBelumKembali.map(
      (it) => `• ${it.station} (SN ...${it.serialNumber.slice(-5)}) dipinjam ${it.namaPeminjam} sejak ${it.jamPinjam} (${it.durasiJam} jam)`
    );
    return `📱 PDA yang lagi dipinjam (${status.pdaBelumKembali.length}):\n${lines.join("\n")}`;
  }

  if (!status.operatorIstirahatLebih60Menit.length) return "Gak ada operator yang istirahat lebih dari 60 menit saat ini 👍";
  const lines = status.operatorIstirahatLebih60Menit.map(
    (o) => `• ${o.nama} (${o.opsId}, ${o.agency}) - istirahat ${o.durasiMenit} menit sejak ${o.jamBreakOut}`
  );
  return `⏳ Operator istirahat >60 menit (${status.operatorIstirahatLebih60Menit.length}):\n${lines.join("\n")}`;
}

// ================= PERFORMANCE BAGGER =================
// Struktur: prDcPerformanceBagger/dailyRecords/{tanggal}/{opsId} = {name, agency, packed, statusInfo}

async function getTodayBaggerRecords() {
  const snap = await db().ref("prDcPerformanceBagger/dailyRecords/" + todayStr()).get();
  const val = snap.val() || {};
  return Object.keys(val).map((opsId) => Object.assign({ opsId }, val[opsId]));
}

async function answerPerformanceBaggerQuestion(text) {
  const lower = text.toLowerCase();
  if (!/bagger|packing|performa|packed|roster/.test(lower)) return null;

  const records = await getTodayBaggerRecords();
  if (!records.length) return "Belum ada data Performance Bagger hari ini.";

  const totalPacked = records.reduce((sum, r) => sum + Number(r.packed || 0), 0);
  const offToday = records.filter((r) => r.statusInfo && r.statusInfo !== "Normal / Bekerja");
  const top = records.slice().sort((a, b) => Number(b.packed || 0) - Number(a.packed || 0))[0];

  const lines = [
    "📊 Ringkasan Performance Bagger hari ini:",
    `• Total Packed: ${totalPacked} pcs (${records.length} operator)`,
    `• Top Packer: ${top ? `${top.name} (${top.packed} pcs)` : "-"}`,
    `• Operator Off/Izin/dll: ${offToday.length}`,
  ];
  if (offToday.length) {
    lines.push(offToday.slice(0, 10).map((r) => `  - ${r.name} (${r.statusInfo})`).join("\n"));
  }
  return lines.join("\n");
}

// ================= ROUTER LINTAS MODUL =================
// Dipanggil dari seatalk-webhook.js. Urutan cek sengaja spesifik dulu
// (Inbound/Rest Time/Bagger/Outbound) baru Inventory paling akhir, niru
// pola routing keyword yang sama kayak Odyssey (report-agent.html) —
// masing-masing handler return null kalau teksnya gak nyangkut ke
// modulnya, jadi lanjut dicoba ke handler berikutnya.
async function answerModuleQuestion(text) {
  const handlers = [
    answerInboundQuestion,
    answerRestTimeQuestion,
    answerPerformanceBaggerQuestion,
    answerOutboundQuestion,
    answerInventoryQuestion,
  ];
  for (const handler of handlers) {
    try {
      const answer = await handler(text);
      if (answer) return answer;
    } catch (err) {
      console.error(`Gagal jalanin handler ${handler.name}:`, err);
    }
  }
  return null;
}

module.exports = {
  db,
  todayStr,
  nowWIB,
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
  sendSeatalkPrivateMessage,
  getStockItems,
  answerInventoryQuestion,
  getInboundTrips,
  computeTripStatus,
  answerInboundQuestion,
  getOutboundRows,
  answerOutboundQuestion,
  getRestAssetData,
  computeRestAssetLiveStatus,
  answerRestTimeQuestion,
  getTodayBaggerRecords,
  answerPerformanceBaggerQuestion,
  answerModuleQuestion,
};
