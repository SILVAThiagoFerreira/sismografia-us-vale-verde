/* =====================================================================
   Sismografia do Desmonte — NBR 9653 · US Vale Verde
   Lê em tempo real a planilha Google Sheets (gviz) e renderiza os gráficos.
   Atualiza a cada acesso — sem servidor, sem build.

   MODELO NORMATIVO (verificado):
   - NBR 9653:2018 = CURVA ÚNICA de PPV×frequência (limite legal brasileiro,
     derivada da BS 7385-2). NÃO possui Tipos 1/2/3.
     4–15 Hz: 15→20 mm/s | 15–40 Hz: 20→50 mm/s | >40 Hz: 50 mm/s (platô)
     f < 4 Hz: critério de DESLOCAMENTO (0,6 mm pico) → v ≈ 3,77·f
   - DIN 4150-3 (Linhas 2/3) e USBM RI 8507 = referências INTERNACIONAIS
     opcionais, apresentadas como comparação — não como subdivisão da NBR.
   - Airblast: 134 dBL pico (Linear) = 100 Pa (NBR 9653, item 5.2).
   - Distância escalonada DE = R/√Q (NBR) ≡ SD (USBM); propagação v = K·DE^−β.

   Aspectos cobertos: velocidade (PPV resultante e por eixo L/V/T),
   frequência dominante, conformidade no gráfico Velocidade×Frequência,
   sobrepressão acústica (airblast), distância escalonada e propagação.
   ===================================================================== */

const SHEET_ID = "1a9s365lfXQR7Nl1wCnc5Bx9wCgAxpDmd";
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1`;
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

/* --- Critérios normativos. Cada um: curva PPV×frequência (pontos [Hz, mm/s]).
       A NBR é o critério padrão (legal); os demais são referência internacional. --- */
const CRITERIA = {
  nbr: {
    label: "NBR 9653:2018",
    short: "NBR 9653",
    desc: "Curva única brasileira (limite legal)",
    color: "#E20613",
    // Abaixo de 4 Hz: iso-linha do critério de deslocamento (0,6 mm pico): v = 2π·f·0,6
    pts: [[1, 3.77], [4, 15], [15, 20], [40, 50], [250, 50]],
    legal: true,
  },
  din2: {
    label: "DIN 4150-3 · Linha 2 (residencial)",
    short: "DIN L2",
    desc: "Referência internacional — habitações",
    color: "#1f6feb",
    pts: [[1, 5], [10, 5], [50, 15], [100, 20], [250, 20]],
  },
  din3: {
    label: "DIN 4150-3 · Linha 3 (sensível)",
    short: "DIN L3",
    desc: "Referência internacional — sensível/patrimônio",
    color: "#6f42c1",
    pts: [[1, 3], [10, 3], [50, 8], [100, 10], [250, 10]],
  },
  usbm: {
    label: "USBM RI 8507 (modern homes)",
    short: "USBM",
    desc: "Referência internacional — residências (drywall)",
    color: "#107c10",
    pts: [[1, 12.7], [3, 12.7], [3, 19], [40, 19], [40, 50.8], [250, 50.8]],
  },
};
const DEFAULT_CRITERION = "nbr";

/* Limites de airblast (dBL pico, Linear). NBR = critério principal. */
const AIRBLAST_REFS = [
  { dBL: 134, label: "NBR 9653 (134 dBL · 100 Pa)", color: "#E20613", solid: true },
  { dBL: 133, label: "USBM/OSMRE 133 dBL (2 Hz)", color: "#c47b00", solid: false },
  { dBL: 129, label: "129 dBL (sensível / incômodo)", color: "#6c747b", solid: false },
];

const DIST_MAX_PLAUSIVEL = 12000; // m — acima disso é erro de cadastro

/** Limite de PPV (mm/s) do critério na frequência dada (interpolação linear). */
function limitAt(critKey, freq) {
  const crit = CRITERIA[critKey] || CRITERIA[DEFAULT_CRITERION];
  const pts = crit.pts;
  if (freq == null || !isFinite(freq)) return null;
  if (freq <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (freq >= x0 && freq <= x1) {
      return y0 + (y1 - y0) * (freq - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

const C = {
  ink: "#38424B",
  inkFill: "rgba(56,66,75,0.10)",
  neutral: "#E20613",
  meta: "#c8c6c4",
  grid: "rgba(56,66,75,0.08)",
  text: "#6c747b",
  ok: "#107c10",
  amber: "#c47b00",
  axisL: "#1f6feb",
  axisV: "#E20613",
  axisT: "#6f42c1",
};

const norm = (s) =>
  (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();

const fmtInt = (n) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(n || 0);
const fmtNum = (n, d = 0) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);

const escapeText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeText(s).replace(/"/g, "&quot;");

const POINT_ALIASES = {
  "PAU FERRO": "PAU-FERRO",
  "TORROES": "TORRÕES",
  "PIXILINGUA": "PIXILINGA",
  "BARRAGEM DE REJEITO": "BARRAGEM DE REJEITOS",
};
const canonPoint = (p) => { const n = norm(p); return POINT_ALIASES[n] || (n || "—"); };

function parseDateCell(v) {
  if (!v) return null;
  // gviz retorna Date(ano, mes, dia, ...) com mês 0-based — igual ao Date do JS.
  const m = String(v).match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
  if (!m) return null;
  const dt = new Date(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  return isNaN(dt.getTime()) ? null : dt;
}

let RECORDS = [];
let CHARTS = {};

/* ===================== Carregamento ===================== */
async function loadSheet() {
  setStatus("loading", "Carregando dados da planilha…");
  let table;
  try {
    const res = await fetch(GVIZ_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("gviz HTTP " + res.status);
    table = parseGviz(await res.text());
  } catch (e) {
    console.warn("gviz falhou, tentando CSV:", e);
    try {
      const res = await fetch(CSV_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("csv HTTP " + res.status);
      table = parseCsv(await res.text());
    } catch (e2) {
      setStatus("error", "Não foi possível acessar a planilha. Verifique se o link está público.");
      throw e2;
    }
  }
  RECORDS = buildRecords(table);
  if (!RECORDS.length) {
    setStatus("error", "Planilha acessada, mas nenhum registro encontrado.");
    return;
  }
  populateFilters();
  setStatus("ok", `${RECORDS.length} eventos carregados.`);
  document.getElementById("last-update").textContent = "Atualizado em " + nowBR();
  render();
}

function parseGviz(txt) {
  const m = txt.match(/setResponse\((\{.*\})\);?\s*$/s);
  const json = JSON.parse(m ? m[1] : txt);
  return json.table;
}

function parseCsv(text) {
  const rows = csvToRows(text);
  const headers = rows.shift();
  const cols = headers.map((label) => ({ id: label, label, type: "string" }));
  const tableRows = rows.map((r) => ({ c: headers.map((h, i) => ({ v: r[i] ?? null })) }));
  return { cols, rows: tableRows };
}

function csvToRows(text) {
  const out = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); out.push(row); row = []; cur = ""; }
      else if (ch === "\r") { /* skip */ }
      else cur += ch;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); out.push(row); }
  return out;
}

/* ===================== Construção dos registros ===================== */
function buildRecords(table) {
  const idx = {};
  table.cols.forEach((c, i) => { idx[norm(c.label)] = i; });
  const g = (key) => { const i = idx[key]; return i === undefined ? -1 : i; };

  const f = {
    data: g("DATA DOS FOGOS (D/M/A)"), horario: g("HORARIO"), id: g("ID DESMONTE"),
    dist: g("DISTANCIA DO SISMOGRAFO (M)"), ponto: g("PONTO DE MONITORAMENTO"),
    nfuros: g("N DE FUROS"), iniciacao: g("INICIACAO"),
    carga: g("CARGA TOTAL (KG)"), mic: g("CARGA MAX. POR ESPERA (KG)"),
    lv: g("L (MM/S)"), lf: g("L (HZ)"),
    vv: g("V (MM/S)"), vf: g("V (HZ)"),
    tv: g("T (MM/S)"), tf: g("T (HZ)"),
    result: g("RESULT. (MM/S)"), air: g("ACUSTICA (DBL)"),
  };

  const recs = [];
  for (const r of table.rows) {
    const cell = (i) => (i < 0 ? null : (r.c[i] && r.c[i].v != null ? r.c[i].v : null));
    const num = (i) => {
      const v = cell(i);
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
      return isFinite(n) ? n : null;
    };

    const dt = parseDateCell(cell(f.data));
    if (!dt) continue;

    const lv = num(f.lv), lf = num(f.lf);
    const vv = num(f.vv), vf = num(f.vf);
    const tv = num(f.tv), tf = num(f.tf);

    // Frequência dominante = frequência do eixo de maior velocidade
    // (corresponde, na prática, à frequência de zero-crossing associada ao pico)
    const axes = [{ v: lv, f: lf }, { v: vv, f: vf }, { v: tv, f: tf }]
      .filter((a) => a.v != null && a.f != null && a.f > 0);
    const dom = axes.length ? axes.reduce((a, b) => (a.v >= b.v ? a : b)) : null;
    const domFreq = dom ? dom.f : [lf, vf, tf].find((x) => x != null && x > 0) || null;

    const ppv = num(f.result);
    const air = num(f.air);
    let dist = num(f.dist);
    if (dist != null && (dist <= 0 || dist > DIST_MAX_PLAUSIVEL)) dist = null;
    const mic = num(f.mic);
    const carga = num(f.carga);

    if (ppv == null && air == null && domFreq == null) continue;

    recs.push({
      date: dt, ano: dt.getFullYear(), mes: dt.getMonth() + 1,
      ponto: canonPoint(cell(f.ponto)),
      dist, mic, carga,
      lv, lf, vv, vf, tv, tf,
      domFreq, ppv, air,
      de: (dist != null && mic != null && mic > 0) ? dist / Math.sqrt(mic) : null,
    });
  }
  recs.sort((a, b) => a.date - b.date);
  return recs;
}

/* ===================== Filtros ===================== */
function populateFilters() {
  const years = [...new Set(RECORDS.map((r) => r.ano).filter(Boolean))].sort();
  const points = [...new Set(RECORDS.map((r) => r.ponto).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const ySel = document.getElementById("filter-year");
  const mSel = document.getElementById("filter-month");
  const pSel = document.getElementById("filter-point");
  const cSel = document.getElementById("filter-criterion");

  ySel.innerHTML = `<option value="">Todos os anos</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
  mSel.innerHTML = `<option value="">Todos os meses</option>` +
    meses.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  pSel.innerHTML = `<option value="">Todos os pontos</option>` +
    points.map((p) => `<option value="${escapeAttr(p)}">${escapeText(p)}</option>`).join("");
  cSel.value = DEFAULT_CRITERION;

  [ySel, mSel, pSel, cSel].forEach((s) => (s.onchange = render));
  document.getElementById("filter-reset").onclick = () => {
    ySel.value = ""; mSel.value = ""; pSel.value = ""; cSel.value = DEFAULT_CRITERION;
    render();
  };
}

function filtered() {
  const y = document.getElementById("filter-year").value;
  const mo = document.getElementById("filter-month").value;
  const p = document.getElementById("filter-point").value;
  const crit = document.getElementById("filter-criterion").value || DEFAULT_CRITERION;
  const data = RECORDS.filter((r) =>
    (!y || String(r.ano) === y) &&
    (!mo || String(r.mes) === mo) &&
    (!p || r.ponto === p)
  );
  return { data, crit };
}

const FILTER_DEFS = [
  { id: "filter-year", label: "Ano" },
  { id: "filter-month", label: "Mês", name: (v) => meses[+v - 1] },
  { id: "filter-point", label: "Ponto" },
  { id: "filter-criterion", label: "Critério", name: (v) => CRITERIA[v] ? CRITERIA[v].short : v },
];

function updateActiveFilters() {
  const box = document.getElementById("active-filters");
  if (!box) return;
  const chips = [];
  FILTER_DEFS.forEach((fd) => {
    const sel = document.getElementById(fd.id);
    if (sel && sel.value) {
      const display = fd.name ? fd.name(sel.value) : sel.value;
      chips.push(
        `<button class="chip" data-id="${fd.id}" type="button">` +
        `<span class="chip__k">${fd.label}:</span> <span class="chip__v">${escapeText(display)}</span>` +
        `<span class="chip__x" aria-hidden="true">×</span></button>`
      );
    }
  });
  box.innerHTML = chips.join("");
  box.style.display = chips.length ? "" : "none";
  box.querySelectorAll(".chip").forEach((btn) => {
    btn.onclick = () => {
      const s = document.getElementById(btn.dataset.id);
      if (s) s.value = s.id === "filter-criterion" ? DEFAULT_CRITERION : "";
      render();
    };
  });
}

/* ===================== Render ===================== */
function render() {
  const { data, crit } = filtered();
  renderKpis(data, crit);
  renderVF(data, crit);
  renderPPV(data, crit);
  renderAir(data);
  renderTrendPPV(data);
  renderTrendAir(data);
  renderByPoint(data);
  renderFreqBands(data, crit);
  renderScaled(data);
  renderAxes(data);
  updateActiveFilters();
}

function renderKpis(data, crit) {
  const ppvs = data.map((r) => r.ppv).filter((v) => v != null);
  const airs = data.map((r) => r.air).filter((v) => v != null);
  const maxPpv = ppvs.length ? Math.max(...ppvs) : null;

  const classified = data.filter((r) => r.ppv != null && r.domFreq != null);
  const ok = classified.filter((r) => r.ppv <= limitAt(crit, r.domFreq)).length;
  const confPct = classified.length ? (ok / classified.length) * 100 : 0;

  const nbrAir = 134;
  const airOver = airs.filter((v) => v > nbrAir).length;
  const maxAir = airs.length ? Math.max(...airs) : null;

  document.getElementById("kpi-count").textContent = fmtInt(data.length);
  document.getElementById("kpi-count-hint").textContent =
    data.length ? `${fmtInt(data.length)} eventos no filtro` : " ";

  const ppvEl = document.getElementById("kpi-ppv");
  ppvEl.textContent = maxPpv != null ? fmtNum(maxPpv, 2) + " mm/s" : "—";
  const limTyp = limitAt(crit, 25);
  ppvEl.style.color = (maxPpv != null && maxPpv > limTyp) ? C.neutral : C.ink;
  document.getElementById("kpi-ppv-hint").textContent =
    maxPpv != null ? `${CRITERIA[crit].short} @ 25 Hz: ${fmtNum(limTyp, 1)} mm/s` : "Velocidade resultante (mm/s)";

  const confEl = document.getElementById("kpi-conf");
  confEl.textContent = fmtNum(confPct, 1) + "%";
  confEl.style.color = confPct >= 99 ? C.ok : confPct >= 95 ? C.amber : C.neutral;
  document.getElementById("kpi-conf-hint").textContent =
    `${fmtInt(ok)} de ${fmtInt(classified.length)} abaixo de ${CRITERIA[crit].short}`;

  const airEl = document.getElementById("kpi-air");
  airEl.textContent = maxAir != null ? fmtNum(maxAir, 1) + " dBL" : "—";
  airEl.style.color = (maxAir != null && maxAir > nbrAir) ? C.neutral : C.ink;
  document.getElementById("kpi-air-hint").textContent =
    airOver > 0 ? `${fmtInt(airOver)} acima de ${nbrAir} dBL (NBR)` : `Referência NBR: ${nbrAir} dBL`;
}

function renderVF(data, crit) {
  const pts = data.filter((r) => r.ppv != null && r.domFreq != null && r.ppv > 0 && r.domFreq > 0)
    .map((r) => ({ x: r.domFreq, y: r.ppv, ok: r.ppv <= limitAt(crit, r.domFreq), r }));

  const datasets = [{
    type: "scatter", label: "Eventos",
    data: pts.map((p) => ({ x: p.x, y: p.y })),
    backgroundColor: pts.map((p) => p.ok ? "rgba(56,66,75,0.45)" : "rgba(226,6,19,0.85)"),
    borderColor: pts.map((p) => p.ok ? "rgba(56,66,75,0.7)" : "#E20613"),
    pointRadius: pts.map((p) => p.ok ? 2.2 : 4),
    pointHoverRadius: 5, order: 3,
  }];

  for (const [key, c] of Object.entries(CRITERIA)) {
    const sel = key === crit;
    datasets.push({
      type: "line", label: sel ? `${c.label} (critério)` : c.label,
      data: c.pts.map(([x, y]) => ({ x, y })),
      borderColor: c.color,
      borderWidth: sel ? 2.4 : 1.2,
      borderDash: sel ? [] : [6, 4],
      pointRadius: 0, tension: 0, fill: false, order: sel ? 1 : 2,
    });
  }

  buildChart("chart-vf", null, {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 14, font: { size: 10 }, padding: 10 } },
        tooltip: tooltipCfg({
          filter: (it) => it.datasetIndex === 0,
          callbacks: {
            title: () => "",
            label: (it) => {
              const p = pts[it.dataIndex]; if (!p) return "";
              const lim = limitAt(crit, p.x);
              return [
                `Ponto: ${p.r.ponto}`, `PPV: ${fmtNum(p.y, 2)} mm/s`,
                `Freq.: ${fmtNum(p.x, 1)} Hz`, `Data: ${fmtDate(p.r.date)}`,
                p.ok ? `✓ abaixo de ${CRITERIA[crit].short} (${fmtNum(lim, 1)} mm/s)` : `✗ acima de ${CRITERIA[crit].short} (${fmtNum(lim, 1)} mm/s)`,
              ];
            },
          },
        }),
      },
      scales: {
        x: { type: "logarithmic", min: 1, max: 250,
          title: { display: true, text: "Frequência dominante (Hz)", color: C.text, font: { size: 9, weight: "bold" } },
          ticks: { color: C.text, font: { size: 8 } }, grid: { color: C.grid } },
        y: { type: "logarithmic", min: 0.05, max: 100,
          title: { display: true, text: "Velocidade resultante — PPV (mm/s)", color: C.text, font: { size: 9, weight: "bold" } },
          ticks: { color: C.text, font: { size: 8 }, callback: (v) => Number.isInteger(v) ? v : "" },
          grid: { color: C.grid } },
      },
    },
  });
}

function renderPPV(data, crit) {
  const pts = data.filter((r) => r.ppv != null);
  if (!pts.length) return buildChart("chart-ppv", null, emptyScatter());
  buildChart("chart-ppv", null, {
    data: {
      datasets: [{
        type: "scatter", label: "PPV por evento (cor = conformidade)",
        data: pts.map((r) => ({ x: r.date.getTime(), y: r.ppv })),
        backgroundColor: pts.map((r) =>
          (r.domFreq != null && r.ppv > limitAt(crit, r.domFreq)) ? "#E20613" : "rgba(56,66,75,0.45)"),
        pointRadius: 2, pointHoverRadius: 5, order: 1,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 10 }, padding: 10 } },
        tooltip: tooltipCfg({
          callbacks: {
            title: () => "",
            label: (it) => {
              const r = pts[it.dataIndex];
              return [`Data: ${fmtDate(r.date)}`, `Ponto: ${r.ponto}`, `PPV: ${fmtNum(r.ppv, 2)} mm/s`, `Freq.: ${fmtNum(r.domFreq, 1)} Hz`];
            },
          },
        }),
      },
      scales: {
        x: { type: "linear", ticks: { color: C.text, font: { size: 8 }, maxTicksLimit: 8, callback: (v) => fmtAxisDate(v) }, grid: { color: C.grid } },
        y: { title: { display: true, text: "PPV (mm/s)", color: C.text, font: { size: 9, weight: "bold" } }, ticks: { color: C.text, font: { size: 8 } }, grid: { color: C.grid }, beginAtZero: true },
      },
    },
  });
}

function renderAir(data) {
  const pts = data.filter((r) => r.air != null);
  if (!pts.length) return buildChart("chart-air", null, emptyScatter());
  const xs = pts.map((r) => r.date.getTime());
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const datasets = [{
    type: "scatter", label: "Airblast por evento",
    data: pts.map((r) => ({ x: r.date.getTime(), y: r.air })),
    backgroundColor: pts.map((r) => r.air > 134 ? "#E20613" : r.air > 129 ? "#c47b00" : "rgba(56,66,75,0.45)"),
    pointRadius: 2, pointHoverRadius: 5, order: AIRBLAST_REFS.length + 1,
  }];
  AIRBLAST_REFS.forEach((ref, i) => {
    datasets.push({
      type: "line", label: ref.label,
      data: [{ x: xmin, y: ref.dBL }, { x: xmax, y: ref.dBL }],
      borderColor: ref.color, borderWidth: ref.solid ? 1.8 : 1.1,
      borderDash: ref.solid ? [] : [6, 4], pointRadius: 0, fill: false, order: AIRBLAST_REFS.length - i,
    });
  });
  buildChart("chart-air", null, {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 10 }, padding: 8 } },
        tooltip: tooltipCfg({
          filter: (it) => it.datasetIndex === 0,
          callbacks: {
            title: () => "",
            label: (it) => {
              const r = pts[it.dataIndex];
              return [`Data: ${fmtDate(r.date)}`, `Ponto: ${r.ponto}`, `Airblast: ${fmtNum(r.air, 1)} dBL`, r.air > 134 ? "✗ acima do limite NBR (134 dBL)" : "✓ abaixo do limite NBR"];
            },
          },
        }),
      },
      scales: {
        x: { type: "linear", ticks: { color: C.text, font: { size: 8 }, maxTicksLimit: 8, callback: (v) => fmtAxisDate(v) }, grid: { color: C.grid } },
        y: { title: { display: true, text: "Airblast — dBL pico (Linear)", color: C.text, font: { size: 9, weight: "bold" } }, ticks: { color: C.text, font: { size: 8 } }, grid: { color: C.grid } },
      },
    },
  });
}

function monthKey(r) { return r.ano + "-" + String(r.mes).padStart(2, "0"); }

function renderTrendPPV(data) {
  const groups = {};
  data.forEach((r) => { if (r.ppv != null) (groups[monthKey(r)] = groups[monthKey(r)] || []).push(r.ppv); });
  const keys = Object.keys(groups).sort();
  if (!keys.length) return buildChart("chart-trend-ppv", null, emptyScatter());
  buildChart("chart-trend-ppv", "line", {
    data: {
      labels: keys.map(monthLabel),
      datasets: [
        { label: "PPV médio (mm/s)", data: keys.map((k) => mean(groups[k])), borderColor: C.ink, backgroundColor: C.inkFill, borderWidth: 2, pointRadius: 2, tension: 0.3, fill: true },
        { label: "PPV máx. (mm/s)", data: keys.map((k) => Math.max(...groups[k])), borderColor: C.neutral, borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0, fill: false },
      ],
    },
    options: lineOpts("PPV (mm/s)", { plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 10 }, padding: 10 } } } }),
  });
}

function renderTrendAir(data) {
  const groups = {};
  data.forEach((r) => { if (r.air != null) (groups[monthKey(r)] = groups[monthKey(r)] || []).push(r.air); });
  const keys = Object.keys(groups).sort();
  if (!keys.length) return buildChart("chart-trend-air", null, emptyScatter());
  buildChart("chart-trend-air", "line", {
    data: {
      labels: keys.map(monthLabel),
      datasets: [
        { label: "Airblast médio (dBL)", data: keys.map((k) => mean(groups[k])), borderColor: C.ink, backgroundColor: C.inkFill, borderWidth: 2, pointRadius: 2, tension: 0.3, fill: true },
        { type: "line", label: "Limite NBR 134 dBL", data: keys.map(() => 134), borderColor: C.neutral, borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0, fill: false },
      ],
    },
    options: lineOpts("Airblast (dBL)", { plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 10 }, padding: 10 } } } }),
  });
}

function renderByPoint(data) {
  const groups = {};
  data.forEach((r) => { if (r.ppv != null) (groups[r.ponto] = groups[r.ponto] || []).push(r.ppv); });
  const entries = Object.entries(groups)
    .map(([p, arr]) => ({ p, max: Math.max(...arr), p95: percentile(arr, 0.95), n: arr.length }))
    .sort((a, b) => b.max - a.max);

  buildChart("chart-by-point", "bar", {
    type: "bar",
    data: {
      labels: entries.map((e) => e.p),
      datasets: [
        { label: "PPV máx. (mm/s)", data: entries.map((e) => e.max), backgroundColor: C.neutral, borderRadius: 2 },
        { label: "PPV p95 (mm/s)", data: entries.map((e) => e.p95), backgroundColor: C.ink, borderRadius: 2 },
      ],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 10 }, padding: 10 } }, tooltip: tooltipCfg() },
      scales: { x: scaleY("PPV (mm/s)"), y: { ...scaleTicks(), grid: { display: false } } },
    },
  });
}

function renderFreqBands(data, crit) {
  const bands = [
    { lo: 0, hi: 4, label: "< 4 Hz*" },
    { lo: 4, hi: 15, label: "4–15 Hz" },
    { lo: 15, hi: 40, label: "15–40 Hz" },
    { lo: 40, hi: 1e9, label: "> 40 Hz" },
  ].map((b) => ({ ...b, count: 0, over: 0 }));
  data.forEach((r) => {
    if (r.domFreq == null) return;
    const b = bands.find((x) => r.domFreq >= x.lo && r.domFreq < x.hi);
    if (!b) return;
    b.count++;
    if (r.ppv != null && r.ppv > limitAt(crit, r.domFreq)) b.over++;
  });
  buildChart("chart-freq", "bar", {
    type: "bar",
    data: {
      labels: bands.map((b) => b.label),
      datasets: [
        { label: "Abaixo do limite", data: bands.map((b) => b.count - b.over), backgroundColor: C.ink, borderRadius: 2 },
        { label: "Acima do limite", data: bands.map((b) => b.over), backgroundColor: C.neutral, borderRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 10 }, padding: 10 } }, tooltip: tooltipCfg() },
      scales: { x: scaleTicks(), y: scaleY("Nº de eventos") },
    },
  });
}

function renderScaled(data) {
  const pts = data.filter((r) => r.de != null && r.ppv != null && r.ppv > 0);
  const head = document.querySelector("#chart-scaled").closest(".chart-block").querySelector(".chart-block__head p");
  if (pts.length < 5) {
    if (head) head.textContent = "SD = R/√Q · sem dados suficientes (carga/distância) no filtro";
    return buildChart("chart-scaled", null, emptyScatter());
  }
  const reg = logLogRegression(pts.map((r) => ({ x: r.de, y: r.ppv })));
  const sdMin = Math.min(...pts.map((r) => r.de)), sdMax = Math.max(...pts.map((r) => r.de));
  const line = [{ x: sdMin, y: reg.k * Math.pow(sdMin, -reg.beta) }, { x: sdMax, y: reg.k * Math.pow(sdMax, -reg.beta) }];
  if (head) head.textContent = `DE = R/√Q (m/√kg) · ${pts.length} eventos · ajuste: v = ${fmtNum(reg.k, 0)}·DE^−${fmtNum(reg.beta, 2)} (R² = ${fmtNum(reg.r2, 2)})`;

  buildChart("chart-scaled", null, {
    data: {
      datasets: [
        { type: "scatter", label: "Eventos", data: pts.map((r) => ({ x: r.de, y: r.ppv })), backgroundColor: "rgba(56,66,75,0.45)", pointRadius: 2, pointHoverRadius: 5, order: 2 },
        { type: "line", label: "Regressão v = K·DE^−β", data: line, borderColor: C.neutral, borderWidth: 2, pointRadius: 0, fill: false, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 10 }, padding: 12 } },
        tooltip: tooltipCfg({
          filter: (it) => it.datasetIndex === 0,
          callbacks: {
            title: () => "",
            label: (it) => {
              const r = pts[it.dataIndex];
              return [`Ponto: ${r.ponto}`, `Data: ${fmtDate(r.date)}`, `DE: ${fmtNum(r.de, 1)} m/√kg`, `PPV: ${fmtNum(r.ppv, 2)} mm/s`, `Q: ${fmtNum(r.mic, 0)} kg · R: ${fmtNum(r.dist, 0)} m`];
            },
          },
        }),
      },
      scales: {
        x: { type: "logarithmic", title: { display: true, text: "Distância escalonada DE (m/√kg)", color: C.text, font: { size: 9, weight: "bold" } }, ticks: { color: C.text, font: { size: 8 } }, grid: { color: C.grid } },
        y: { type: "logarithmic", min: 0.01, title: { display: true, text: "PPV (mm/s)", color: C.text, font: { size: 9, weight: "bold" } }, ticks: { color: C.text, font: { size: 8 }, callback: (v) => Number.isInteger(v) ? v : "" }, grid: { color: C.grid } },
      },
    },
  });
}

function renderAxes(data) {
  const container = document.getElementById("extra-charts");
  if (!container) return;
  container.innerHTML = "";

  const defs = [
    { key: "lv", fkey: "lf", label: "Longitudinal (L)", color: C.axisL },
    { key: "vv", fkey: "vf", label: "Vertical (V)", color: C.axisV },
    { key: "tv", fkey: "tf", label: "Transversal (T)", color: C.axisT },
  ];

  for (const d of defs) {
    const gV = {}, gF = {};
    data.forEach((r) => {
      if (r[d.key] != null) (gV[monthKey(r)] = gV[monthKey(r)] || []).push(r[d.key]);
      if (r[d.fkey] != null && r[d.fkey] > 0) (gF[monthKey(r)] = gF[monthKey(r)] || []).push(r[d.fkey]);
    });
    const series = [
      [`Velocidade — ${d.label}`, Object.keys(gV).sort(), (k) => mean(gV[k]), "mm/s"],
      [`Frequência — ${d.label}`, Object.keys(gF).sort(), (k) => mean(gF[k]), "Hz"],
    ];
    for (const [title, keys, valFn, yTitle] of series) {
      const card = document.createElement("div");
      card.className = "extra-card";
      const id = "extra-" + d.key + "-" + (yTitle === "Hz" ? "f" : "v");
      card.innerHTML = `<p class="extra-card__title"><span class="extra-card__swatch" style="background:${d.color}"></span>${title}</p><div class="extra-card__canvas"><canvas id="${id}"></canvas></div>`;
      container.appendChild(card);
      if (!keys.length) continue;
      buildChart(id, "line", {
        type: "line",
        data: {
          labels: keys.map(monthLabel),
          datasets: [{ data: keys.map(valFn), borderColor: d.color, backgroundColor: d.color + "22", borderWidth: 1.8, pointRadius: 1.5, tension: 0.3, fill: true }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: tooltipCfg({ callbacks: { label: (it) => fmtNum(it.parsed.y, 2) + " " + yTitle } }) },
          scales: {
            x: { ticks: { color: C.text, font: { size: 7 }, maxTicksLimit: 6, autoSkip: true }, grid: { display: false }, border: { color: C.grid } },
            y: { ticks: { color: C.text, font: { size: 7 } }, grid: { color: C.grid }, border: { color: C.grid }, title: { display: true, text: yTitle, color: C.text, font: { size: 8 } } },
          },
        },
      });
    }
  }
}

/* ===================== Helpers ===================== */
function buildChart(canvasId, _kind, config) {
  if (CHARTS[canvasId]) CHARTS[canvasId].destroy();
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  // Chart.js 4 exige config.type. Se ausente, usa o tipo do 1º dataset (mixed charts) ou scatter.
  if (!config.type) {
    const ds = config.data && config.data.datasets && config.data.datasets[0];
    config.type = (ds && ds.type) || _kind || "scatter";
  }
  CHARTS[canvasId] = new Chart(ctx, config);
}

const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
function fmtDate(d) { return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear(); }
function fmtAxisDate(ms) { const d = new Date(ms); return meses[d.getMonth()] + "/" + String(d.getFullYear()).slice(2); }
function monthLabel(k) { const [y, m] = k.split("-"); return meses[+m - 1] + "/" + y.slice(2); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function logLogRegression(pts) {
  const xs = pts.map((p) => Math.log10(p.x));
  const ys = pts.map((p) => Math.log10(p.y));
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxy / (sxx || 1);
  const a = my - b * mx;
  let syy = 0, sse = 0;
  for (let i = 0; i < n; i++) { const pred = a + b * xs[i]; sse += (ys[i] - pred) ** 2; syy += (ys[i] - my) ** 2; }
  const r2 = syy ? 1 - sse / syy : 0;
  return { k: Math.pow(10, a), beta: -b, r2 };
}

function emptyScatter() {
  return {
    type: "scatter",
    data: { datasets: [{ data: [], showLine: false }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } },
  };
}

function baseOpts() { return { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false } } }; }
function tooltipCfg(extra) { return Object.assign({}, tooltipBase(), extra || {}); }
function tooltipBase() {
  return {
    enabled: true, backgroundColor: "rgba(56,66,75,0.95)", titleColor: "#ffffff", bodyColor: "#e8e8e8",
    borderColor: "#38424B", borderWidth: 0, padding: 12, cornerRadius: 4, caretSize: 8, caretPadding: 8,
    displayColors: true, boxWidth: 10, boxHeight: 10, boxPadding: 4,
    titleFont: { weight: "700", size: 12 }, bodyFont: { size: 11 }, bodySpacing: 5,
  };
}
function lineOpts(yTitle, extra) {
  const base = baseOpts();
  return Object.assign({}, base, {
    scales: { x: Object.assign({}, scaleTicks(), { grid: { display: false } }), y: scaleY(yTitle) },
    elements: { line: { borderJoinStyle: "round" } },
    plugins: Object.assign({}, base.plugins, (extra && extra.plugins) || {}),
  });
}
function scaleTicks() { return { ticks: { color: C.text, font: { size: 7 }, maxRotation: 45, autoSkip: true }, border: { color: C.grid } }; }
function scaleY(title) {
  return {
    title: { display: !!title, text: title, color: C.text, font: { size: 8, weight: "bold" } },
    ticks: { color: C.text, font: { size: 7 } }, grid: { color: C.grid }, border: { color: C.grid },
  };
}

function setStatus(kind, text) {
  const el = document.getElementById("status");
  if (!el) return;
  el.classList.remove("is-loading", "is-ok", "is-error");
  if (kind === "loading") el.classList.add("is-loading");
  if (kind === "ok") el.classList.add("is-ok");
  if (kind === "error") el.classList.add("is-error");
  const t = document.getElementById("status-text");
  if (t) t.textContent = text;
}
function nowBR() { return new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); }

document.addEventListener("DOMContentLoaded", () => {
  if (!window.Chart) {
    setStatus("error", "Biblioteca de gráficos (Chart.js) não carregou. Verifique sua conexão.");
    return;
  }
  Chart.defaults.font.family = "'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";
  Chart.defaults.font.size = 7;
  Chart.defaults.color = "#6c747b";
  Chart.defaults.borderColor = "rgba(56,66,75,0.08)";
  Object.assign(Chart.defaults.plugins.tooltip, tooltipBase());
  loadSheet().catch((e) => console.error(e));
  setInterval(() => loadSheet().catch(() => {}), 10 * 60 * 1000);
});
