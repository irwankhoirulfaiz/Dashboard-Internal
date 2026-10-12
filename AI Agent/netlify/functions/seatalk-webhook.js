/**
 * netlify/functions/seatalk-webhook.js
 * ------------------------------------------------------------------
 * Ini yang jadi Callback URL di SeaTalk Open Platform:
 *   https://<site-lo>.netlify.app/.netlify/functions/seatalk-webhook
 *
 * Menangani 2 hal:
 *   1. Verification request (event_type: "event_verification")
 *   2. Pesan masuk dari user -> jawab pakai data LIVE dari semua modul
 *      dashboard (Inbound, Outbound, Rest Time/PDA, Performance Bagger,
 *      Inventory Control) lewat router answerModuleQuestion.
 */

const crypto = require("crypto");
const {
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
  sendSeatalkPrivateMessage,
  answerModuleQuestion,
} = require("./_seatalk-common");

function isValidSignature(rawBody, signatureHeader) {
  const signingSecret = process.env.SEATALK_SIGNING_SECRET;
  if (!signatureHeader || !signingSecret) return false;
  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const rawBody = event.body || "";
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // 1) Verification saat pertama kali setup Callback URL.
  //    SeaTalk cuma butuh { "seatalk_challenge": "..." } balik, TANPA
  //    signature check dulu di step ini (belum ada signature terkirim).
  if (body.event_type === "event_verification") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatalk_challenge: body.event.seatalk_challenge }),
    };
  }

  // 2) Verifikasi signature buat event selanjutnya.
  //    NOTE: cek nama header aslinya waktu event beneran masuk (log dulu
  //    semua header di Netlify function log), lalu sesuaikan key di bawah.
  const signatureHeader =
    event.headers["signature"] || event.headers["x-seatalk-signature"];
  if (!isValidSignature(rawBody, signatureHeader)) {
    console.warn("Signature SeaTalk gak valid / belum dicocokkan skemanya.");
    // return { statusCode: 401, body: "invalid signature" };
    // (sementara di-comment biar gak ke-block pas masih uji coba format signature)
  }

  const seatalkEvent = body.event || {};
  const messageText = seatalkEvent?.message?.text?.content;
  if (!messageText) {
    return { statusCode: 200, body: "ok" };
  }

  let answer;
  try {
    answer =
      (await answerModuleQuestion(messageText)) ||
      "Maaf, aku belum ngerti pertanyaan itu. Coba tanya soal Stock/Consumable (Inventory), trip/Late Arrival/In Transit (Inbound), aging/backlog (Outbound), PDA/istirahat (Rest Time), atau performa/packing (Performance Bagger) ya.";
  } catch (err) {
    console.error("Gagal ambil data dashboard:", err);
    answer = "Lagi ada gangguan ambil data dari dashboard, coba lagi sebentar ya.";
  }

  try {
    const token = await getSeatalkAccessToken();
    if (seatalkEvent.group_id) {
      await sendSeatalkGroupMessage(token, seatalkEvent.group_id, answer);
    } else if (seatalkEvent.employee_code) {
      await sendSeatalkPrivateMessage(token, seatalkEvent.employee_code, answer);
    }
  } catch (err) {
    console.error("Gagal kirim balasan SeaTalk:", err);
  }

  return { statusCode: 200, body: "ok" };
};
