/**
 * netlify/functions/check-ops-alerts.js
 * ------------------------------------------------------------------
 * Scheduled Function (jalan tiap 15 menit, jadwal di netlify.toml —
 * disamain kayak check-low-stock.js). Ngecek 2 kondisi operasional:
 *
 *   1. Late Arrival numpuk hari ini (Inbound) — alert SEKALI per hari,
 *      begitu jumlahnya nembus LATE_ARRIVAL_ALERT_THRESHOLD. Reset
 *      otomatis kalau angkanya turun lagi di bawah ambang batas
 *      (misal ada koreksi data).
 *   2. Operator istirahat >60 menit (Rest Time) — alert PER opsId per
 *      hari (gak spam ulang tiap 15 menit buat orang yang sama yang
 *      masih istirahat).
 *
 * State notifikasi disimpen di Firebase (bukan di memory function,
 * karena tiap invocation Netlify Function itu proses baru).
 */

const {
  db,
  getInboundTrips,
  getRestAssetData,
  computeRestAssetLiveStatus,
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
  todayStr,
} = require("./_seatalk-common");

// Sesuaikan sendiri angka ini kalau ambang batasnya kurang/kelebihan sensitif.
const LATE_ARRIVAL_ALERT_THRESHOLD = 5;

async function checkLateArrival(groupId, token) {
  const today = todayStr();
  const trips = await getInboundTrips();
  const lateToday = trips.filter((t) => {
    const d = t.tanggal || (t.stdOrigin ? String(t.stdOrigin).slice(0, 10) : null);
    return d === today && t.statusText === "Late Arrival";
  });

  const stateRef = db().ref("prDcInboundTracking/alertState/" + today);
  const stateSnap = await stateRef.get();
  const alreadyAlerted = !!(stateSnap.val() && stateSnap.val().lateArrivalAlerted);

  if (lateToday.length >= LATE_ARRIVAL_ALERT_THRESHOLD && !alreadyAlerted) {
    const lines = lateToday.slice(0, 10).map((t) => `• ${t.tripNum} (${t.routeName}) - ${t.vendorName}`);
    const text =
      `🔴 ALERT: Late Arrival Numpuk - SOC\n` +
      `${lateToday.length} trip Late Arrival hari ini (ambang batas ${LATE_ARRIVAL_ALERT_THRESHOLD}):\n` +
      lines.join("\n") +
      (lateToday.length > 10 ? "\n…dan lainnya" : "") +
      "\nCek detail di modul Inbound ya.";
    await sendSeatalkGroupMessage(token, groupId, text);
    await stateRef.update({ lateArrivalAlerted: true, lateArrivalCount: lateToday.length });
  } else if (lateToday.length < LATE_ARRIVAL_ALERT_THRESHOLD && alreadyAlerted) {
    await stateRef.update({ lateArrivalAlerted: false });
  }
}

async function checkRestOvertime(groupId, token) {
  const today = todayStr();
  const data = await getRestAssetData();
  const status = computeRestAssetLiveStatus(data.logs, data.assetLogs, data.master, data.stationMap);

  const newlyAlerted = [];
  for (const o of status.operatorIstirahatLebih60Menit) {
    const flagRef = db().ref(`prDcMonitoring/overtimeAlertState/${today}/${o.opsId}`);
    const snap = await flagRef.get();
    if (!snap.val()) {
      newlyAlerted.push(o);
      await flagRef.set(true);
    }
  }

  if (newlyAlerted.length) {
    const lines = newlyAlerted.map(
      (o) => `• ${o.nama} (${o.opsId}, ${o.agency}) - udah ${o.durasiMenit} menit sejak ${o.jamBreakOut}`
    );
    const text = `⏳ ALERT: Operator Istirahat >60 Menit - SOC\n${lines.join("\n")}\nCek Rest Time Monitoring ya.`;
    await sendSeatalkGroupMessage(token, groupId, text);
  }
}

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;
  let token;
  try {
    token = await getSeatalkAccessToken();
  } catch (err) {
    console.error("Gagal ambil token SeaTalk:", err);
    return { statusCode: 500, body: "gagal ambil token" };
  }

  try {
    await checkLateArrival(groupId, token);
  } catch (err) {
    console.error("Gagal cek Late Arrival:", err);
  }

  try {
    await checkRestOvertime(groupId, token);
  } catch (err) {
    console.error("Gagal cek Rest Overtime:", err);
  }

  return { statusCode: 200, body: "ok" };
};
