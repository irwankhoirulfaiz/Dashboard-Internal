/**
 * netlify/functions/daily-briefing.js
 * ------------------------------------------------------------------
 * Scheduled Function - kirim ringkasan operasional otomatis ke grup
 * SeaTalk sekali sehari TANPA nunggu ditanya (jadwal di netlify.toml,
 * default jam 08:00 WIB = 01:00 UTC — geser sendiri sesuai jam shift
 * kalau perlu, format cron di netlify.toml).
 */

const {
  getInboundTrips,
  getStockItems,
  getRestAssetData,
  computeRestAssetLiveStatus,
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
  todayStr,
} = require("./_seatalk-common");

async function buildBriefingText() {
  const today = todayStr();
  const lines = [`☀️ Daily Briefing SOC - ${today}`, ""];

  try {
    const trips = await getInboundTrips();
    const todayTrips = trips.filter((t) => {
      const d = t.tanggal || (t.stdOrigin ? String(t.stdOrigin).slice(0, 10) : null);
      return d === today;
    });
    const late = todayTrips.filter((t) => t.statusText === "Late Arrival").length;
    const transit = todayTrips.filter((t) => t.statusText === "In Transit").length;
    lines.push(`🚚 Inbound: ${todayTrips.length} trip (🔴 ${late} Late, 🟡 ${transit} Transit)`);
  } catch (err) {
    console.error("Gagal ambil data Inbound buat briefing:", err);
    lines.push("🚚 Inbound: (gagal ambil data)");
  }

  try {
    const stock = await getStockItems();
    const low = stock.filter((it) => Number(it.qty ?? 0) <= Number(it.minStock ?? 0));
    lines.push(`📦 Inventory: ${low.length} Asset stock menipis`);
  } catch (err) {
    console.error("Gagal ambil data Stock buat briefing:", err);
    lines.push("📦 Inventory: (gagal ambil data)");
  }

  try {
    const data = await getRestAssetData();
    const status = computeRestAssetLiveStatus(data.logs, data.assetLogs, data.master, data.stationMap);
    lines.push(
      `⏳ Rest Time: ${status.operatorIstirahatLebih60Menit.length} operator istirahat >60 menit, ${status.pdaBelumKembali.length} PDA belum kembali`
    );
  } catch (err) {
    console.error("Gagal ambil data Rest Time buat briefing:", err);
    lines.push("⏳ Rest Time: (gagal ambil data)");
  }

  lines.push("", "Ketik pertanyaan ke bot ini buat detail lebih lanjut ya 🙌");
  return lines.join("\n");
}

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;
  try {
    const text = await buildBriefingText();
    const token = await getSeatalkAccessToken();
    await sendSeatalkGroupMessage(token, groupId, text);
    return { statusCode: 200, body: "briefing terkirim" };
  } catch (err) {
    console.error("Gagal kirim Daily Briefing:", err);
    return { statusCode: 500, body: "gagal kirim briefing" };
  }
};
