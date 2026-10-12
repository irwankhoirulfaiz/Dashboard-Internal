/**
 * netlify/functions/_alert-utils.js
 * ------------------------------------------------------------------
 * Helper bersama buat check-occupancy-alerts (Early Loading) dan
 * check-stuck-aging (Parcel Stuck). Daftar tag/Cc cukup diedit di sini.
 */
const SEATALK_API_BASE = "https://openapi.seatalk.io";
const FB_ROOT = "prDcOutboundMonitoring";
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_MSG_CHARS = 3500; // batas aman panjang 1 pesan SeaTalk

// ---- Auto tag (mention) di alert teks. Semua harus member grup tujuan. ----
const ENABLE_MENTION = true; // false = semua alert tanpa tag
const TAG_EMAILS = [
  "kristian.yoga@spxexpress.com",
  "m.badrianoor@spxexpress.com",
  "aditya.ludbianoko@spxexpress.com",
  "alpianor.alpianor@spxexpress.com",
  "eka.prayogi@spxexpress.com",
  "hananya.yudhohusodho@spxexpress.com",
  "ilham.setiawan@spxexpress.com",
  "dwi.putra@spxexpress.com",
  "panji.pratama@spxexpress.com",
  "ridwan.susanto@spxexpress.com",
  "kurniawan.wawan@spxexpress.com",
];
const CC_EMAILS = [
  "irwan.faiz@spxexpress.com",
  "muhammad.reza@spxexpress.com",
  "rizky.armanda@spxexpress.com",
  "pratama.daniel@spxexpress.com",
];

const mentionTag = (email) => `<mention-tag target="seatalk://user?email=${email}"/>`;

// Baris tag + cc yang ditempel di akhir pesan alert.
function buildMentionText(lead = "Ayo digasin request sekarang") {
  if (!ENABLE_MENTION) return "";
  const parts = [];
  if (TAG_EMAILS.length) parts.push(lead + " " + TAG_EMAILS.map(mentionTag).join(" "));
  if (CC_EMAILS.length) parts.push("Cc : " + CC_EMAILS.map(mentionTag).join(" "));
  return parts.join("\n");
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

function formatWibStamp(isoStr) {
  const d = new Date(new Date(isoStr).getTime() + WIB_OFFSET_MS);
  const bln = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agt", "Sep", "Okt", "Nov", "Des"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())} ${bln[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}.${pad(d.getUTCMinutes())} WIB`;
}

function chunkBlocks(blocks, maxChars = MAX_MSG_CHARS) {
  const messages = [];
  let current = "";
  blocks.forEach((b) => {
    const next = current ? current + "\n\n" + b : b;
    if (next.length > maxChars && current) {
      messages.push(current);
      current = b;
    } else {
      current = next;
    }
  });
  if (current) messages.push(current);
  return messages;
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

// Kirim teks alert (format 1 = markdown, wajib biar <mention-tag> jadi @tag beneran).
async function sendAlertText(accessToken, groupId, text) {
  const res = await fetch(`${SEATALK_API_BASE}/messaging/v2/group_chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      group_id: groupId,
      message: { tag: "text", text: { format: 1, content: text } },
    }),
  });
  return res.json();
}

// SeaTalk balikin { code: 0 } kalau sukses. Kalau bukan 0, anggap gagal biar
// state "sudah dialert" gak ke-tandain padahal pesannya gak sampai.
function assertSent(result, what) {
  console.log(`respon SeaTalk (${what}): ` + JSON.stringify(result));
  if (result && typeof result.code === "number" && result.code !== 0) {
    throw new Error(`SeaTalk nolak pesan (${what}): ` + JSON.stringify(result));
  }
}

module.exports = {
  FB_ROOT,
  WIB_OFFSET_MS,
  MAX_MSG_CHARS,
  buildMentionText,
  agingLabel,
  wibDayNumber,
  todayWibStr,
  fromColumnar,
  slugKey,
  agingDaysOf,
  formatWibStamp,
  chunkBlocks,
  sendGroupImage,
  sendAlertText,
  assertSent,
};
