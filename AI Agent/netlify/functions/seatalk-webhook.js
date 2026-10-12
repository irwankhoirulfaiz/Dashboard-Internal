const crypto = require("crypto");
const {
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
  sendSeatalkPrivateMessage,
  answerModuleQuestion,
} = require("./_seatalk-common");
const { askGemini } = require("./_gemini-chat");

// Nama mention bot persis seperti yang tampil di SeaTalk (buat dibersihin
// dari teks pertanyaan). Bisa dioverride lewat env var BOT_MENTION_NAME.
const BOT_MENTION_NAME = process.env.BOT_MENTION_NAME || "Smith - Reminder Support";

const AI_FOOTER = "\n\nℹ️ Dijawab AI (Gemini). Mohon verifikasi kembali untuk memastikan keakuratannya.";
const HELP_TEXT =
  "Halo, aku Smith - Reminder Support 👋 Tanya apa aja soal operasional SOC, atau data live pakai kata kunci: late/transit (Inbound), aging/backlog (Outbound), stock/consumable (Inventory), performa/packing (Performance Bagger).";

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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Buang markup mention & nama bot dari teks, sisakan pertanyaannya aja.
function cleanQuestion(text) {
  return String(text || "")
    .replace(/<mention-tag[^>]*\/?>(<\/mention-tag>)?/gi, " ")
    .replace(new RegExp("@" + escapeRegExp(BOT_MENTION_NAME), "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildAnswer(question) {
  if (!question) return HELP_TEXT;

  // 1) Data live dashboard dulu (akurat). null = bukan pertanyaan data.
  try {
    const dataAnswer = await answerModuleQuestion(question);
    if (dataAnswer) return dataAnswer;
  } catch (err) {
    console.error("Gagal ambil data dashboard:", err);
    return "Lagi ada gangguan ambil data dari dashboard, coba lagi sebentar ya.";
  }

  // 2) Pertanyaan bebas -> Gemini.
  try {
    const aiAnswer = await askGemini(question);
    return aiAnswer + AI_FOOTER;
  } catch (err) {
    console.error("Gagal jawab pakai Gemini:", err);
    return "Maaf, AI-nya lagi sibuk/gangguan. Coba tanya lagi sebentar lagi ya, atau pakai kata kunci data (late, aging, stock, performa).";
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
  const msg = seatalkEvent.message || {};
  if (!seatalkEvent.message) {
    return { statusCode: 200, body: "ok" };
  }

  // TEMPORARY: log payload buat mastiin nama field thread_id / message_id /
  // plain_text. Hapus kalau udah beres.
  console.log("SeaTalk event payload:", JSON.stringify(body));

  const rawText = (msg.text && (msg.text.plain_text || msg.text.content)) || "";
  const question = cleanQuestion(rawText);
  const answer = await buildAnswer(question);

  try {
    const token = await getSeatalkAccessToken();
    if (seatalkEvent.group_id) {
      // Kalau pesan sudah di dalam thread, pakai thread-nya. Kalau pesan
      // biasa di main feed, jadikan pesan itu root thread baru.
      const threadId =
        msg.thread_id && msg.thread_id !== "0" ? msg.thread_id : msg.message_id;

      const result = await sendSeatalkGroupMessage(
        token,
        seatalkEvent.group_id,
        answer,
        { threadId }
      );

      // Fallback: kalau thread/pesan gak ketemu (4009/4010), balas pakai
      // quote aja supaya tetap nyambung ke pesan yang nge-tag.
      if (result && (result.code === 4009 || result.code === 4010)) {
        await sendSeatalkGroupMessage(token, seatalkEvent.group_id, answer, {
          quotedMessageId: msg.message_id,
        });
      }
    } else if (seatalkEvent.employee_code) {
      await sendSeatalkPrivateMessage(token, seatalkEvent.employee_code, answer);
    }
  } catch (err) {
    console.error("Gagal kirim balasan SeaTalk:", err);
  }

  return { statusCode: 200, body: "ok" };
};
