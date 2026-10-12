/**
 * netlify/functions/check-low-stock.js
 * ------------------------------------------------------------------
 * Scheduled Function (jalan otomatis, gak perlu dipanggil manual).
 * Netlify Functions gak punya trigger real-time seperti Firebase
 * Cloud Functions, jadi ini jalan tiap 15 menit ngecek semua Asset
 * di Stock, dan kirim notif ke SeaTalk kalau ada yang BARU menipis
 * (belum pernah dinotif sebelumnya).
 *
 * Jadwalnya diatur lewat netlify.toml (lihat instruksi di bawah),
 * BUKAN lewat kode di sini.
 */

const {
  db,
  getStockItems,
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
} = require("./_seatalk-common");

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;
  const items = await getStockItems();

  const newlyLow = items.filter((it) => {
    const qty = Number(it.qty ?? 0);
    const minStock = Number(it.minStock ?? 0);
    const isLow = qty <= minStock;
    const alreadyNotified = it.lowStockNotified === true;
    return isLow && !alreadyNotified;
  });

  const backToSafe = items.filter((it) => {
    const qty = Number(it.qty ?? 0);
    const minStock = Number(it.minStock ?? 0);
    const isLow = qty <= minStock;
    return !isLow && it.lowStockNotified === true;
  });

  if (!newlyLow.length && !backToSafe.length) {
    return { statusCode: 200, body: "no changes" };
  }

  if (newlyLow.length) {
    const lines = newlyLow.map(
      (it) => `• ${it.name}: sisa ${it.qty} ${it.unit || "pcs"} (Min: ${it.minStock})`
    );
    const text = `⚠️ Stock Menipis - SOC\n${lines.join("\n")}\nCek & reorder di Inventory Control ya.`;

    try {
      const token = await getSeatalkAccessToken();
      await sendSeatalkGroupMessage(token, groupId, text);
    } catch (err) {
      console.error("Gagal kirim notif SeaTalk:", err);
    }
  }

  // Tandain di Firebase biar gak dikirim ulang tiap 15 menit selama masih menipis,
  // dan reset tanda begitu stock udah di-restock (balik aman).
  const updates = {};
  newlyLow.forEach((it) => {
    updates[`inventoryControl/SOC/stock/${it.id}/lowStockNotified`] = true;
  });
  backToSafe.forEach((it) => {
    updates[`inventoryControl/SOC/stock/${it.id}/lowStockNotified`] = false;
  });
  if (Object.keys(updates).length) {
    await db().ref().update(updates);
  }

  return { statusCode: 200, body: `notified ${newlyLow.length} asset(s)` };
};
