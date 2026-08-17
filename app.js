/* ============================================================
   FenoFresa · app.js
   Análisis en el dispositivo (visión por color + blobs) +
   base de datos local (IndexedDB). Todo corre offline.
   ============================================================ */

// --------- Estadios y clases ---------
const ESTADIOS = [
  { key: "verde",  label: "Verde",  color: [92, 140, 63],  auto: true,  low: true  },
  { key: "blanco", label: "Blanco", color: [216, 210, 176], auto: true,  low: true  },
  { key: "envero", label: "Envero", color: [228, 138, 163], auto: true,  low: false },
  { key: "rojo",   label: "Rojo",   color: [196, 48, 60],   auto: true,  low: false },
];
const FLOR_COLOR = [233, 196, 106];
const ANALYSIS_MAX = 720; // px máx para el análisis (velocidad en móvil)

// ============================================================
//  BASE DE DATOS LOCAL (IndexedDB)
// ============================================================
const DB_NAME = "fenofresa";
const STORE = "registros";
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
async function dbAdd(rec) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const out = [];
    const tx = db.transaction(STORE, "readonly");
    tx.objectStore(STORE).openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out.push(cur.value); cur.continue(); }
      else res(out.sort((a, b) => a.fecha_iso < b.fecha_iso ? 1 : -1));
    };
    tx.onerror = () => rej(tx.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbClear() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

// ============================================================
//  CARGA DE IMAGEN + REDIMENSIONADO
// ============================================================
async function loadToCanvas(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
  const w0 = bmp.width, h0 = bmp.height;
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
  return cv;
}

// ============================================================
//  VISIÓN: clasificación por HSV + conteo de blobs
// ============================================================
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}

// Devuelve índice de clase: 0=ninguna,1=flor(amarillo),2=rojo,3=envero,4=blanco,5=verde
function classify(h, s, v, sens) {
  const sMin = 0.30 - sens * 0.15;   // sens 0..1 baja el umbral de saturación
  // 1) Flor: centro amarillo
  if (h >= 38 && h <= 66 && s > 0.35 && v > 0.5) return 1;
  // 2) Rojo maduro
  if ((h <= 14 || h >= 344) && s > Math.max(0.35, sMin) && v > 0.22) return 2;
  // 3) Envero (rosado / pinta): rojo pálido, menos saturado
  if ((h <= 22 || h >= 328) && s > 0.14 && s <= 0.5 && v > 0.55) return 3;
  // 4) Blanco: muy claro y poco saturado
  if (s < 0.16 && v > 0.78) return 4;
  // 5) Verde
  if (h >= 70 && h <= 165 && s > Math.max(0.22, sMin) && v > 0.14) return 5;
  return 0;
}

// Etiquetado de componentes conexas sobre una máscara binaria
function countBlobs(mask, w, h, minArea) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let blobs = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 1 || seen[i]) continue;
    let sp = 0, area = 0;
    stack[sp++] = i; seen[i] = 1;
    while (sp > 0) {
      const p = stack[--sp]; area++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0)     { const n = p - 1; if (mask[n] === 1 && !seen[n]) { seen[n] = 1; stack[sp++] = n; } }
      if (x < w - 1) { const n = p + 1; if (mask[n] === 1 && !seen[n]) { seen[n] = 1; stack[sp++] = n; } }
      if (y > 0)     { const n = p - w; if (mask[n] === 1 && !seen[n]) { seen[n] = 1; stack[sp++] = n; } }
      if (y < h - 1) { const n = p + w; if (mask[n] === 1 && !seen[n]) { seen[n] = 1; stack[sp++] = n; } }
    }
    if (area >= minArea) blobs++;
  }
  return blobs;
}

function analyze(cv, opts) {
  const { minArea, sens } = opts;
  const ctx = cv.getContext("2d");
  const w = cv.width, h = cv.height;
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const n = w * h;

  const labels = new Uint8Array(n);       // clase por píxel
  const cov = [0, 0, 0, 0, 0, 0];         // cobertura por clase
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const [hh, ss, vv] = rgbToHsv(px[j], px[j + 1], px[j + 2]);
    const c = classify(hh, ss, vv, sens);
    labels[i] = c; cov[c]++;
  }

  // Overlay
  const overlay = ctx.createImageData(w, h);
  const od = overlay.data;
  const colorFor = (c) =>
    c === 1 ? FLOR_COLOR :
    c === 2 ? ESTADIOS[3].color :
    c === 3 ? ESTADIOS[2].color :
    c === 4 ? ESTADIOS[1].color :
    c === 5 ? ESTADIOS[0].color : null;
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    const col = colorFor(c);
    const j = i * 4;
    if (col) { od[j] = col[0]; od[j + 1] = col[1]; od[j + 2] = col[2]; od[j + 3] = 150; }
    else od[j + 3] = 0;
  }

  // Conteo de blobs por clase
  const maskOf = (cls) => { const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = labels[i] === cls ? 1 : 0; return m; };
  const counts = {
    flores: countBlobs(maskOf(1), w, h, Math.max(6, minArea * 0.5)),
    rojo:   countBlobs(maskOf(2), w, h, minArea),
    envero: countBlobs(maskOf(3), w, h, minArea),
    blanco: countBlobs(maskOf(4), w, h, minArea),
    verde:  countBlobs(maskOf(5), w, h, minArea),
  };
  const coverage = {
    rojo:   +(100 * cov[2] / n).toFixed(1),
    envero: +(100 * cov[3] / n).toFixed(1),
    blanco: +(100 * cov[4] / n).toFixed(1),
    verde:  +(100 * cov[5] / n).toFixed(1),
    flores: +(100 * cov[1] / n).toFixed(1),
  };
  return { counts, coverage, overlay, w, h };
}

// ============================================================
//  ESTADO + UI
// ============================================================
const $ = (id) => document.getElementById(id);
let currentCanvas = null;      // canvas de análisis
let currentOverlay = null;     // ImageData overlay
let showOverlay = true;

function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
function pct(part, total) { return total ? Math.round((part / total) * 1000) / 10 : 0; }
function stamp() {
  const d = new Date(), p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function drawPreview() {
  const cv = $("preview");
  if (!currentCanvas) return;
  cv.width = currentCanvas.width; cv.height = currentCanvas.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(currentCanvas, 0, 0);
  if (showOverlay && currentOverlay) {
    const tmp = document.createElement("canvas");
    tmp.width = cv.width; tmp.height = cv.height;
    tmp.getContext("2d").putImageData(currentOverlay, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }
  $("preview-wrap").classList.remove("hidden");
}

function setCount(key, val) {
  const el = $("c-" + key);
  if (el) el.value = Math.max(0, val | 0);
  updateFrutos();
}
function getCount(key) { return Math.max(0, parseInt($("c-" + key).value || "0", 10)); }
function updateFrutos() {
  const t = getCount("verde") + getCount("blanco") + getCount("envero") + getCount("rojo");
  $("frutos-total").textContent = t;
  // barra de estadios
  const seg = $("stage-meter"); seg.innerHTML = "";
  ESTADIOS.forEach((e) => {
    const c = getCount(e.key), p = pct(c, t);
    if (!p) return;
    const d = document.createElement("div");
    d.className = "seg";
    d.style.width = p + "%";
    d.style.background = `rgb(${e.color.join(",")})`;
    d.style.color = e.key === "blanco" ? "#3a3720" : "#fff";
    d.textContent = p >= 9 ? p + "%" : "";
    d.title = `${e.label}: ${c} (${p}%)`;
    seg.appendChild(d);
  });
  if (!t) seg.innerHTML = '<div class="seg empty-seg">Sin frutos</div>';
}

async function runAnalysis(file) {
  $("analyze-status").textContent = "Procesando en el dispositivo…";
  $("btn-analyze").disabled = true;
  try {
    currentCanvas = await loadToCanvas(file);
    const opts = { minArea: parseInt($("min-area").value, 10), sens: parseInt($("sens").value, 10) / 100 };
    const res = analyze(currentCanvas, opts);
    currentOverlay = res.overlay;
    showOverlay = true; $("btn-overlay").textContent = "Ocultar detección";
    drawPreview();
    ESTADIOS.forEach((e) => setCount(e.key, res.counts[e.key]));
    setCount("flores", res.counts.flores);
    // cobertura
    const cvbox = $("coverage"); cvbox.innerHTML = "";
    [["rojo", "Rojo"], ["envero", "Envero"], ["blanco", "Blanco"], ["verde", "Verde"], ["flores", "Flores"]]
      .forEach(([k, l]) => {
        const s = document.createElement("span");
        s.innerHTML = `${l} <b>${res.coverage[k]}%</b>`;
        cvbox.appendChild(s);
      });
    $("results").classList.remove("hidden");
    $("analyze-status").textContent = "Primer conteo listo. Revisa y ajusta antes de guardar.";
  } catch (err) {
    $("analyze-status").textContent = "No se pudo analizar la imagen: " + err.message;
  } finally {
    $("btn-analyze").disabled = false;
  }
}

async function saveRecord() {
  const rec = {
    id: uuid(),
    fecha_iso: new Date().toISOString(),
    fecha: new Date().toLocaleString("es-MX"),
    parcela: $("f-parcela").value.trim(),
    variedad: $("f-variedad").value.trim(),
    verde: getCount("verde"), blanco: getCount("blanco"),
    envero: getCount("envero"), rojo: getCount("rojo"),
    flores: getCount("flores"), botones: getCount("botones"),
    coverage: lastCoverage(),
    notas: $("f-notas").value.trim(),
    metodo: "CV-color (dispositivo)",
  };
  rec.frutos = rec.verde + rec.blanco + rec.envero + rec.rojo;
  await dbAdd(rec);
  $("analyze-status").textContent = "Registro guardado en la base local ✓";
  await refreshTable();
}
function lastCoverage() {
  const out = {};
  document.querySelectorAll("#coverage span b").forEach((b, i) => {
    const label = ["rojo", "envero", "blanco", "verde", "flores"][i];
    out[label] = parseFloat(b.textContent);
  });
  return out;
}

// --------- Tabla / registros ---------
async function refreshTable() {
  const rows = await dbAll();
  $("rec-count").textContent = rows.length;
  const tb = $("tbody"); tb.innerHTML = "";
  if (!rows.length) {
    $("empty-rec").classList.remove("hidden");
    $("table-wrap").classList.add("hidden");
    return;
  }
  $("empty-rec").classList.add("hidden");
  $("table-wrap").classList.remove("hidden");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="dim">${r.fecha}</td>
      <td>${r.parcela || "—"}</td>
      <td class="strong">${r.frutos}</td>
      <td class="mono">${r.verde}</td>
      <td class="mono">${r.blanco}</td>
      <td class="mono">${r.envero}</td>
      <td class="mono">${r.rojo}</td>
      <td class="mono">${r.flores}</td>
      <td class="mono">${r.botones}</td>
      <td><button class="del" data-id="${r.id}">×</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll(".del").forEach((b) =>
    b.addEventListener("click", async () => { await dbDelete(b.dataset.id); refreshTable(); }));
}

// --------- Exportar / importar ---------
function fnameBase() {
  return ($("f-filename").value || `fenofresa_${stamp()}`).replace(/[^\w\-.]+/g, "_");
}
function download(content, ext, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${fnameBase()}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
async function exportCSV() {
  const rows = await dbAll(); if (!rows.length) return;
  const cols = ["fecha", "parcela", "variedad", "frutos_total", "verde", "blanco", "envero", "rojo",
    "pct_verde", "pct_blanco", "pct_envero", "pct_rojo", "flores", "botones", "metodo", "notas"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = rows.map((r) => {
    const t = r.frutos;
    return [r.fecha, r.parcela, r.variedad, t, r.verde, r.blanco, r.envero, r.rojo,
      pct(r.verde, t), pct(r.blanco, t), pct(r.envero, t), pct(r.rojo, t),
      r.flores, r.botones, r.metodo, r.notas].map(esc).join(",");
  });
  download("\uFEFF" + [cols.join(","), ...body].join("\r\n"), "csv", "text/csv;charset=utf-8;");
}
async function exportJSON() {
  const rows = await dbAll(); if (!rows.length) return;
  download(JSON.stringify({ herramienta: "FenoFresa", generado: new Date().toISOString(), registros: rows }, null, 2),
    "json", "application/json");
}
function importJSON(file) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const data = JSON.parse(r.result);
      const list = data.registros || data;
      for (const x of list) {
        x.id = x.id || uuid();
        x.frutos = x.frutos ?? (x.verde + x.blanco + x.envero + x.rojo);
        await dbAdd(x);
      }
      refreshTable();
      $("analyze-status").textContent = "Registros importados a la base local ✓";
    } catch { $("analyze-status").textContent = "JSON inválido."; }
  };
  r.readAsText(file);
}

// ============================================================
//  PWA: instalación + service worker + estado de red
// ============================================================
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e; $("btn-install").classList.remove("hidden");
});
function netStatus() {
  const dot = $("net-dot");
  const on = navigator.onLine;
  dot.classList.toggle("on", on);
  dot.title = on ? "En línea" : "Sin conexión (funciona igual)";
}
window.addEventListener("online", netStatus);
window.addEventListener("offline", netStatus);

// ============================================================
//  ARRANQUE
// ============================================================
function bind() {
  $("file-input").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (f) { runAnalysis(f); }
  });
  $("btn-analyze").addEventListener("click", () => $("file-input").click());
  $("btn-camera").addEventListener("click", () => $("camera-input").click());
  $("camera-input").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (f) runAnalysis(f);
  });
  $("btn-overlay").addEventListener("click", () => {
    showOverlay = !showOverlay;
    $("btn-overlay").textContent = showOverlay ? "Ocultar detección" : "Mostrar detección";
    drawPreview();
  });
  ["verde", "blanco", "envero", "rojo", "flores", "botones"].forEach((k) => {
    $("c-" + k).addEventListener("input", updateFrutos);
    $("s-" + k + "-up").addEventListener("click", () => setCount(k, getCount(k) + 1));
    $("s-" + k + "-dn").addEventListener("click", () => setCount(k, getCount(k) - 1));
  });
  $("btn-save").addEventListener("click", saveRecord);
  $("btn-csv").addEventListener("click", exportCSV);
  $("btn-json").addEventListener("click", exportJSON);
  $("btn-import").addEventListener("click", () => $("import-input").click());
  $("import-input").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importJSON(f); e.target.value = ""; });
  $("btn-clear").addEventListener("click", async () => {
    if (confirm("¿Vaciar toda la base local? Exporta antes si quieres conservarla.")) { await dbClear(); refreshTable(); }
  });
  $("btn-install").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt(); await deferredPrompt.userChoice;
    deferredPrompt = null; $("btn-install").classList.add("hidden");
  });
  $("adv-toggle").addEventListener("click", () => $("advanced").classList.toggle("hidden"));
  $("min-area-val") && $("min-area").addEventListener("input", () => $("min-area-val").textContent = $("min-area").value);
  $("sens").addEventListener("input", () => $("sens-val").textContent = $("sens").value);
  $("f-filename").value = `fenofresa_${stamp()}`;
}

async function init() {
  bind();
  netStatus();
  updateFrutos();
  try { await refreshTable(); }
  catch { $("db-warn").classList.remove("hidden"); }
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch {}
  }
}
document.addEventListener("DOMContentLoaded", init);
