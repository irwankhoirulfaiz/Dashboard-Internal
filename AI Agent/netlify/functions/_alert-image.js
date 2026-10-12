/**
 * netlify/functions/_alert-image.js
 * ------------------------------------------------------------------
 * Render tabel "Early Loading" jadi gambar PNG (base64) buat dikirim ke
 * SeaTalk. Pakai @resvg/resvg-wasm (WASM murni, gak butuh binary native)
 * + font DejaVu dari package npm "dejavu-fonts-ttf" (Lambda gak punya font
 * sistem, jadi font HARUS disertakan).
 */
const fs = require("fs");
const path = require("path");
const { initWasm, Resvg } = require("@resvg/resvg-wasm");

// require JSON ini cuma biar bundler Netlify ikut nyertain package font-nya.
const fontPkgJson = require.resolve("dejavu-fonts-ttf/package.json");
const FONT_DIR = path.join(path.dirname(fontPkgJson), "ttf");
const WASM_PATH = path.join(path.dirname(require.resolve("@resvg/resvg-wasm")), "index_bg.wasm");

let wasmReady = null;
function ensureWasm() {
  if (!wasmReady) wasmReady = initWasm(fs.readFileSync(WASM_PATH));
  return wasmReady;
}

let fontBuffers = null;
function getFontBuffers() {
  if (!fontBuffers) {
    fontBuffers = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map(
      (f) => new Uint8Array(fs.readFileSync(path.join(FONT_DIR, f)))
    );
  }
  return fontBuffers;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Pecah nama route di pemisah " - " biar muat max ~MAX_CHARS per baris.
function wrapRoute(label, maxChars = 46, maxLines = 3) {
  const parts = String(label).split(" - ");
  const lines = [];
  let cur = "";
  parts.forEach((p) => {
    const next = cur ? cur + " - " + p : p;
    if (next.length > maxChars && cur) {
      lines.push(cur + " -");
      cur = p;
    } else {
      cur = next;
    }
  });
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/ -$/, "").slice(0, maxChars - 1) + "…";
  }
  return lines;
}

const LEVEL_STYLE = {
  1: { bg: "#fef3c7", fg: "#92400e", pill: "#f59e0b", pillFg: "#ffffff" },
  2: { bg: "#ffedd5", fg: "#9a3412", pill: "#f97316", pillFg: "#ffffff" },
  3: { bg: "#fee2e2", fg: "#991b1b", pill: "#ef4444", pillFg: "#ffffff" },
  4: { bg: "#fee2e2", fg: "#991b1b", pill: "#dc2626", pillFg: "#ffffff" },
  5: { bg: "#fecaca", fg: "#7f1d1d", pill: "#991b1b", pillFg: "#ffffff" },
  6: { bg: "#fecaca", fg: "#7f1d1d", pill: "#7f1d1d", pillFg: "#ffffff" },
};

/**
 * rows: [{ label, total, agingLabel, level, shortTitle }]
 * opts: { title, subtitle }
 * return: string base64 PNG
 */
async function renderEarlyLoadingTable(rows, opts = {}) {
  await ensureWasm();

  const W = 980;
  const PAD = 18;
  const col = { no: PAD, route: PAD + 48, qty: 560, aging: 690, status: 800 }; // x awal tiap kolom
  const HEAD_H = 74;
  const TH_H = 34;
  const FONT = "DejaVu Sans";

  const rowInfos = rows.map((r) => {
    const lines = wrapRoute(r.label);
    return { r, lines, h: Math.max(38, 16 + lines.length * 18) };
  });
  const bodyH = rowInfos.reduce((s, x) => s + x.h, 0);
  const H = HEAD_H + TH_H + bodyH + 34;

  let y = HEAD_H + TH_H;
  let body = "";
  rowInfos.forEach((info, i) => {
    const { r, lines, h } = info;
    const st = LEVEL_STYLE[r.level] || LEVEL_STYLE[1];
    const cy = y + h / 2;
    body += `<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${h}" fill="${i % 2 ? "#ffffff" : "#f8fafc"}"/>`;
    body += `<rect x="${PAD}" y="${y}" width="5" height="${h}" fill="${st.pill}"/>`;
    body += `<text x="${col.no + 12}" y="${cy + 5}" font-size="14" fill="#64748b">${i + 1}</text>`;
    const startY = cy - ((lines.length - 1) * 18) / 2 + 5;
    lines.forEach((ln, li) => {
      body += `<text x="${col.route}" y="${startY + li * 18}" font-size="14" font-weight="bold" fill="#0f172a">${esc(ln)}</text>`;
    });
    body += `<text x="${col.qty + 100}" y="${cy + 6}" font-size="17" font-weight="bold" text-anchor="end" fill="${st.fg}">${esc(r.total.toLocaleString("id-ID"))}</text>`;
    body += `<text x="${col.aging + 45}" y="${cy + 5}" font-size="14" font-weight="bold" text-anchor="middle" fill="#334155">${esc(r.agingLabel)}</text>`;
    body += `<rect x="${col.status}" y="${cy - 13}" width="${W - PAD - col.status}" height="26" rx="13" fill="${st.pill}"/>`;
    body += `<text x="${col.status + (W - PAD - col.status) / 2}" y="${cy + 5}" font-size="12" font-weight="bold" text-anchor="middle" fill="${st.pillFg}">${esc(r.shortTitle)}</text>`;
    y += h;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0" y="0" width="${W}" height="${HEAD_H}" fill="#0f172a"/>
  <text x="${PAD}" y="32" font-size="21" font-weight="bold" fill="#ffffff">${esc(opts.title || "Early Loading Alert")}</text>
  <text x="${PAD}" y="56" font-size="13" fill="#94a3b8">${esc(opts.subtitle || "")}</text>
  <rect x="0" y="${HEAD_H}" width="${W}" height="${TH_H}" fill="#1e293b"/>
  <text x="${col.no + 12}" y="${HEAD_H + 22}" font-size="12" font-weight="bold" fill="#e2e8f0">NO</text>
  <text x="${col.route}" y="${HEAD_H + 22}" font-size="12" font-weight="bold" fill="#e2e8f0">ROUTE</text>
  <text x="${col.qty + 100}" y="${HEAD_H + 22}" font-size="12" font-weight="bold" text-anchor="end" fill="#e2e8f0">PARCEL</text>
  <text x="${col.aging + 45}" y="${HEAD_H + 22}" font-size="12" font-weight="bold" text-anchor="middle" fill="#e2e8f0">LONGEST AGING</text>
  <text x="${col.status + (W - PAD - col.status) / 2}" y="${HEAD_H + 22}" font-size="12" font-weight="bold" text-anchor="middle" fill="#e2e8f0">STATUS</text>
  ${body}
  <text x="${PAD}" y="${H - 12}" font-size="11" fill="#94a3b8">Parcel = total di staging area (Parcel + Bulky), sama seperti dashboard Outbound Monitoring.</text>
</svg>`;

  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: getFontBuffers(),
      loadSystemFonts: false,
      defaultFontFamily: FONT,
    },
  });
  const png = resvg.render().asPng();
  return Buffer.from(png).toString("base64");
}

module.exports = { renderEarlyLoadingTable };
