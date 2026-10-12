// Urutan chain = urutan fallback: kalau model paling depan (atau
// preferred_model dari dropdown) kena error yang "boleh di-retry" (rate
// limit, model retired/gak available, dst — lihat isRetryableModelError),
// proxy otomatis nyoba model berikutnya di daftar ini sampai ada yang jawab.
// Mapping nama tampilan "Odyssey x.x" -> id Gemini asli ada di report-agent.html
// (konstanta ODYSSEY_MODEL_NAMES), urutannya sengaja disamain persis biar gak
// bingung pas debug.
//
// CATATAN: "gemini-2.5-flash-lite" & "gemini-2.5-flash" SENGAJA dikeluarin
// dari chain ini. Google udah nutup akses seri 2.5 buat API key baru ("This
// model ... is no longer available to new users" -> 404), jadi 2 model itu
// gak akan pernah kepakai sama key yang baru di-generate. Kalau suatu saat
// ternyata key-nya masih dapet akses (key lama/legacy), tinggal tambahin
// lagi ke array ini.
const GEMINI_MODEL_CHAIN = [
  "gemini-3-flash",         // Odyssey 3.0
  "gemini-3.1-flash-lite",  // Odyssey 3.1
  "gemini-3.5-flash",       // Odyssey 3.5 Pro
  "gemini-3.5-flash-lite",  // Odyssey 3.5
  "gemini-3.6-flash",       // Odyssey 3.6
  "gemini-3.7-flash",       // Odyssey 3.7
  "gemini-3.8-flash",       // Odyssey 3.8
];

// Tangga thinkingLevel dari paling hemat ke paling "mikir". Dukungan level
// ini BEDA-BEDA tiap model & sering berubah tiap Google rilis versi baru
// (contoh nyata: "minimal" jalan di Gemini 3.7 Flash tapi udah gak didukung
// lagi di Gemini 3.8 Flash). Daripada proxy hardcode 1 level yang gampang
// basi, kalau ketemu error "thinking level X not supported", proxy naikin
// level ini setapak demi setapak di MODEL YANG SAMA dulu sebelum nyerah &
// pindah ke model berikutnya di chain.
const THINKING_LEVEL_LADDER = ["minimal", "low", "medium", "high"];

function geminiUrlFor(model) {
  return "https://generativelanguage.googleapis.com/v1beta/models/" +
    model + ":generateContent";
}

function errMsgOf(data){
  return JSON.stringify((data && data.error) || "");
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Gemini kadang ngasih tau di body error berapa detik lagi kudu nunggu
// (field "retryDelay", format "12.3s"). Kalau ada, pakai itu; kalau nggak,
// fallback ke jeda pendek. Di-cap biar gak nunggu kelamaan & bikin function
// keburu timeout di Netlify (default 10s buat function biasa).
function retryDelayMsOf(data){
  const msg = errMsgOf(data);
  const m = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  const seconds = m ? parseFloat(m[1]) : 2;
  return Math.min(Math.max(seconds, 1), 6) * 1000;
}

// Kena limit pemakaian (kuota/rate limit) — model-nya sendiri sehat, cuma
// lagi penuh. Layak dicoba ulang, baik di model yang sama (nanti) maupun
// pindah ke model lain.
function isRateLimitError(status, data){
  if (status === 429) return true;
  return /RESOURCE_EXHAUSTED/i.test(errMsgOf(data));
}

// Model-nya lagi kebanjiran trafik di sisi Google (503 "The model is
// overloaded"/"currently experiencing high demand"/UNAVAILABLE) — BUKAN
// soal kuota kita, tapi tetep layak pindah ke model lain di chain (nunggu
// di model yang sama percuma, model lain lebih mungkin lowong).
function isOverloadedError(status, data){
  if (status === 503) return true;
  const msg = errMsgOf(data);
  return /UNAVAILABLE/i.test(msg) || /overloaded/i.test(msg) || /experiencing high demand/i.test(msg);
}

// Model-nya sendiri yang bermasalah: udah di-retire/gak available buat key
// ini (404), atau ID model salah/gak ketemu. Gak ada gunanya diulang di
// model yang sama — harus lompat ke model LAIN di chain.
function isModelUnavailableError(status, data){
  if (status === 404) return true;
  const msg = errMsgOf(data);
  return /NOT_FOUND/i.test(msg) || /no longer available/i.test(msg);
}

// Model-nya nolak nilai thinkingLevel yang dikirim (400). Ini spesifik ke
// parameter, bukan ke model-nya — jadi masih layak dicoba ulang di MODEL
// YANG SAMA pakai level lain di THINKING_LEVEL_LADDER, sebelum nyerah &
// pindah model.
function isThinkingLevelError(status, data){
  if (status !== 400) return false;
  const msg = errMsgOf(data);
  return /thinking/i.test(msg) && /not supported/i.test(msg);
}

function buildChain(preferredModel){
  if (!preferredModel || GEMINI_MODEL_CHAIN.indexOf(preferredModel) === -1){
    return GEMINI_MODEL_CHAIN;
  }
  return [preferredModel].concat(GEMINI_MODEL_CHAIN.filter(m => m !== preferredModel));
}

async function callGemini(model, geminiBodyBase, thinkingLevel, apiKey){
  const geminiBody = Object.assign({}, geminiBodyBase, {
    generationConfig: Object.assign({}, geminiBodyBase.generationConfig, {
      thinkingConfig: { thinkingLevel: thinkingLevel }
    })
  });
  const geminiRes = await fetch(geminiUrlFor(model) + "?key=" + apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiBody)
  });
  const data = await geminiRes.json();
  return { status: geminiRes.status, data: data };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "GEMINI_API_KEY belum di-set di Environment Variables Netlify"
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Body request bukan JSON valid" })
    };
  }

  const { system, contents, max_tokens, thinking_level, preferred_model } = payload;

  if (!contents || !Array.isArray(contents)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Field 'contents' wajib ada dan berupa array" })
    };
  }

  const requestedThinkingLevel = THINKING_LEVEL_LADDER.includes(thinking_level) ? thinking_level : "minimal";
  const startLadderIdx = THINKING_LEVEL_LADDER.indexOf(requestedThinkingLevel);

  const geminiBodyBase = {
    contents: contents,
    generationConfig: {
      maxOutputTokens: max_tokens || 1000,
      // Maksa Gemini balikin JSON yang beneran valid (bukan cuma nurut
      // instruksi teks di system prompt yang sifatnya "permintaan" doang).
      // Ini yang bikin balesan bisa berantakan/gagal JSON.parse sebelumnya,
      // apalagi di model Lite yang kurang nurut instruksi format.
      responseMimeType: "application/json"
    }
  };
  if (system) {
    geminiBodyBase.system_instruction = { parts: [{ text: system }] };
  }

  const modelChain = buildChain(preferred_model);

  // Jalanin 1x "putaran" nyisir seluruh modelChain. Kalau ada yang sukses
  // (atau error yang gak layak di-retry), balikin langsung sebagai respons
  // final ({done:true, ...}). Kalau SEMUA model di putaran ini abis dicoba
  // & semuanya rate-limit/gak-available, balikin {done:false, lastResult}
  // biar caller bisa mutusin mau retry putaran lagi atau nyerah.
  async function runChainPass(){
    let lastResult = null;
    for (let i = 0; i < modelChain.length; i++){
      const model = modelChain[i];

      // Buat MODEL INI, mulai dari level yang diminta terus naik tangga
      // (minimal -> low -> medium -> high) kalau kena error "thinking level
      // not supported". Begitu level-nya cocok atau errornya BUKAN soal
      // thinking level, langsung berhenti di sini (baik sukses maupun error
      // lain yang mesti pindah model).
      for (let lvl = startLadderIdx; lvl < THINKING_LEVEL_LADDER.length; lvl++){
        const thinkingLevel = THINKING_LEVEL_LADDER[lvl];
        try {
          const result = await callGemini(model, geminiBodyBase, thinkingLevel, apiKey);
          lastResult = result;

          if (isThinkingLevelError(result.status, result.data)){
            continue; // naik ke level berikutnya, model yang sama
          }
          if (isRateLimitError(result.status, result.data) || isModelUnavailableError(result.status, result.data) || isOverloadedError(result.status, result.data)){
            break; // nyerah di model ini, lanjut ke model berikutnya di chain
          }

          // Sukses ATAU error lain yang gak layak di-retry (mis. safety
          // block, payload salah) -> langsung balikin ke client apa adanya.
          result.data.modelUsed = model;
          return {
            done: true,
            statusCode: result.status,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(result.data)
          };
        } catch (e) {
          lastResult = { status: 502, data: { error: "Gagal menghubungi Gemini API (" + model + "): " + e.message } };
          break; // error jaringan, gak ada gunanya ganti-ganti thinkingLevel — lanjut ke model berikutnya
        }
      }
    }
    return { done: false, lastResult: lastResult };
  }

  // Putaran pertama nyisir semua model di chain. Kalau SEMUA kena rate limit
  // & prompt-nya kecil (obrolan ringan, bukan dump data gede kayak query
  // Inventory Control/report), worth it nunggu bentar (pakai retryDelay dari
  // Gemini kalau ada) terus nyoba SATU putaran lagi. Prompt yang GEDE
  // sengaja GAK di-retry di sini — ngirim ulang payload segede itu ke 7
  // model cuma bikin kuota token per-menit makin cepet abis, bukan bantu.
  // Cuma 1x extra pass & cuma buat prompt kecil biar durasi function tetep
  // aman dari timeout Netlify.
  const SMALL_PROMPT_CHAR_LIMIT = 20000; // ~5rb token, kasar
  const promptCharLen = JSON.stringify(geminiBodyBase).length;

  let pass = await runChainPass();
  if (!pass.done && pass.lastResult && isRateLimitError(pass.lastResult.status, pass.lastResult.data) && promptCharLen < SMALL_PROMPT_CHAR_LIMIT){
    await sleep(retryDelayMsOf(pass.lastResult.data));
    pass = await runChainPass();
  }

  if (pass.done){
    return {
      statusCode: pass.statusCode,
      headers: pass.headers,
      body: pass.body
    };
  }

  const lastResult = pass.lastResult;
  const finalData = lastResult ? lastResult.data : { error: "Semua model di GEMINI_MODEL_CHAIN gagal, gak ada respons." };
  return {
    statusCode: (lastResult && lastResult.status) || 502,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(finalData)
  };
};
