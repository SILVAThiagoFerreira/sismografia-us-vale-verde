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
const SHEET_TAB = "Sismografia"; // aba com os eventos (a planilha também tem abas de apoio)
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(SHEET_TAB)}`;
// Fonte principal: exportação CSV da primeira aba (Sismografia). Traz o texto completo;
// o gviz descarta texto em colunas que ele classifica como numéricas (ex.: ID desmonte).
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

/* --- Critérios normativos. Cada um: curva PPV×frequência (pontos [Hz, mm/s]).
       A NBR é o critério padrão (legal); os demais são referência internacional. --- */
const CRITERIA = {
  nbr: {
    label: "NBR 9653:2018",
    short: "NBR 9653",
    desc: "Curva única brasileira (limite legal)",
    color: "#B40E16",
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
  { dBL: 134, label: "NBR 9653 (134 dBL · 100 Pa)", color: "#B40E16", solid: true },
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
  ink: "#3C4148",
  inkFill: "rgba(60,65,72,0.10)",
  neutral: "#B40E16",
  rose: "#E3B5B9",
  grey: "#8A9099",
  meta: "#c8c6c4",
  grid: "rgba(0,0,0,0.07)",
  text: "#404040",
  ok: "#107c10",
  amber: "#c47b00",
  axisL: "#B40E16",
  axisV: "#3C4148",
  axisT: "#8A9099",
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
let SEARCH_OPTIONS = [];
let SEARCH_ACTIVE_INDEX = -1;
let CHARTS = {};

/* ===================== Carregamento ===================== */
async function loadSheet() {
  setStatus("loading", "Carregando dados da planilha…");
  let table;
  try {
    const res = await fetch(`${CSV_URL}&t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("csv HTTP " + res.status);
    table = parseCsv(await res.text());
  } catch (e) {
    console.warn("CSV falhou, tentando gviz:", e);
    try {
      const res = await fetch(GVIZ_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("gviz HTTP " + res.status);
      table = parseGviz(await res.text());
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
  const tableRows = rows.map((r) => ({ c: headers.map((h, i) => ({ v: csvValue(r[i]) })) }));
  return { cols, rows: tableRows };
}

// CSV exporta datas como M/D/AAAA (locale da planilha) — converte para o mesmo formato do gviz.
function csvValue(raw) {
  if (raw == null || raw === "") return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw).trim());
  return m ? `Date(${+m[3]},${+m[1] - 1},${+m[2]})` : raw;
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
    nfuros: g("N DE FUROS"), iniciacao: g("INICIACAO"), tipo: g("CATEGORIA / TIPO"),
    carga: g("CARGA TOTAL (KG)"), mic: g("CARGA MAX. POR ESPERA (KG)"),
    lv: g("L (MM/S)"), lf: g("L (HZ)"),
    vv: g("V (MM/S)"), vf: g("V (HZ)"),
    tv: g("T (MM/S)"), tf: g("T (HZ)"),
    result: g("RESULT. (MM/S)"), air: g("ACUSTICA (DBL)"),
  };

  const recs = [];
  const seen = new Set(); // linhas idênticas (cópias de lançamento) contam uma vez só
  for (const r of table.rows) {
    const rowKey = JSON.stringify(r.c.map((c) => (c ? c.v : null)));
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
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
      fogo: String(cell(f.id) ?? "").trim(),
      tipo: String(cell(f.tipo) ?? "").trim() || "Não classificado",
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
  const fSel = document.getElementById("filter-fire");
  const tSel = document.getElementById("filter-type");
  const search = document.getElementById("filter-search");
  const cSel = document.getElementById("filter-criterion");
  const types = [...new Set(RECORDS.map((r) => r.tipo).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  tSel.innerHTML = `<option value="">Todos os tipos</option>` +
    types.map((t) => `<option value="${escapeAttr(t)}">${escapeText(t)}</option>`).join("");

  ySel.innerHTML = `<option value="">Todos os anos</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
  mSel.innerHTML = `<option value="">Todos os meses</option>` +
    meses.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  pSel.innerHTML = `<option value="">Todos os pontos</option>` +
    points.map((p) => `<option value="${escapeAttr(p)}">${escapeText(p)}</option>`).join("");
  const fires = [...new Set(RECORDS.map((r) => r.fogo).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  fSel.innerHTML = `<option value="">Todos os fogos</option>` +
    fires.map((f) => `<option value="${escapeAttr(f)}">${escapeText(f)}</option>`).join("");
  SEARCH_OPTIONS = [
    ...fires.map((value) => ({ kind: "Fogo", value })),
    ...points.map((value) => ({ kind: "Ponto", value })),
    ...years.map((value) => ({ kind: "Ano", value: String(value) })),
    ...[...new Set(RECORDS.map((r) => fmtDate(r.date)).filter(Boolean))]
      .map((value) => ({ kind: "Data", value }))
  ];
  cSel.value = DEFAULT_CRITERION;
  const currentYear = String(new Date().getFullYear());
  ySel.value = years.some((year) => String(year) === currentYear) ? currentYear : "";

  [ySel, mSel, pSel, fSel, tSel, cSel].forEach((s) => (s.onchange = render));
  search.oninput = () => {
    SEARCH_ACTIVE_INDEX = -1;
    search.classList.remove("is-selected");
    updateSearchSuggestions();
    render();
  };
  search.onfocus = updateSearchSuggestions;
  search.onkeydown = (event) => {
    const suggestions = document.querySelectorAll("#search-suggestions .search-suggestion");
    if (event.key === "ArrowDown" && suggestions.length) {
      event.preventDefault();
      SEARCH_ACTIVE_INDEX = Math.min(SEARCH_ACTIVE_INDEX + 1, suggestions.length - 1);
      updateSearchSuggestions();
    } else if (event.key === "ArrowUp" && suggestions.length) {
      event.preventDefault();
      SEARCH_ACTIVE_INDEX = Math.max(SEARCH_ACTIVE_INDEX - 1, 0);
      updateSearchSuggestions();
    } else if (event.key === "Enter" && SEARCH_ACTIVE_INDEX >= 0 && suggestions[SEARCH_ACTIVE_INDEX]) {
      event.preventDefault();
      selectSearchSuggestion(suggestions[SEARCH_ACTIVE_INDEX].dataset.value);
    } else if (event.key === "Escape") {
      hideSearchSuggestions();
    }
  };
  search.onblur = () => window.setTimeout(hideSearchSuggestions, 120);
  document.getElementById("filter-reset").onclick = () => {
    ySel.value = ""; mSel.value = ""; pSel.value = ""; fSel.value = ""; tSel.value = "";
    search.value = ""; SEARCH_ACTIVE_INDEX = -1; cSel.value = DEFAULT_CRITERION;
    hideSearchSuggestions();
    render();
  };
}

function updateSearchSuggestions() {
  const input = document.getElementById("filter-search");
  const box = document.getElementById("search-suggestions");
  if (!input || !box) return;
  const query = input.value.trim().toLocaleLowerCase("pt-BR");
  const matches = SEARCH_OPTIONS
    .filter((item) => !query || item.value.toLocaleLowerCase("pt-BR").includes(query))
    .slice(0, 8);
  if (!matches.length) {
    box.innerHTML = query ? `<div class="search-suggestions__empty">Nenhum item encontrado</div>` : "";
    box.hidden = !query;
    return;
  }
  box.innerHTML = matches.map((item, index) =>
    `<button class="search-suggestion${index === SEARCH_ACTIVE_INDEX ? " is-active" : ""}" type="button" role="option" data-value="${escapeAttr(item.value)}">` +
    `<span class="search-suggestion__kind">${escapeText(item.kind)}</span>` +
    `<strong>${escapeText(item.value)}</strong></button>`
  ).join("");
  box.hidden = false;
  box.querySelectorAll(".search-suggestion").forEach((button) => {
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => selectSearchSuggestion(button.dataset.value);
  });
}

function selectSearchSuggestion(value) {
  const input = document.getElementById("filter-search");
  if (!input) return;
  input.value = value;
  SEARCH_ACTIVE_INDEX = -1;
  hideSearchSuggestions();
  input.classList.add("is-selected");
  render();
}

function hideSearchSuggestions() {
  const box = document.getElementById("search-suggestions");
  if (box) box.hidden = true;
}

function filtered() {
  const y = document.getElementById("filter-year").value;
  const mo = document.getElementById("filter-month").value;
  const p = document.getElementById("filter-point").value;
  const fire = document.getElementById("filter-fire").value;
  const tipo = document.getElementById("filter-type").value;
  const query = document.getElementById("filter-search").value.trim().toLocaleLowerCase("pt-BR");
  const crit = document.getElementById("filter-criterion").value || DEFAULT_CRITERION;
  const data = RECORDS.filter((r) =>
    (!y || String(r.ano) === y) &&
    (!mo || String(r.mes) === mo) &&
    (!p || r.ponto === p) &&
    (!fire || r.fogo === fire) &&
    (!tipo || r.tipo === tipo) &&
    (!query || [r.fogo, r.ponto, r.date?.toLocaleDateString("pt-BR"), r.date?.toISOString(), r.ano, r.mes]
      .filter((value) => value != null)
      .some((value) => String(value).toLocaleLowerCase("pt-BR").includes(query)))
  );
  return { data, crit };
}

const FILTER_DEFS = [
  { id: "filter-year", label: "Ano" },
  { id: "filter-month", label: "Mês", name: (v) => meses[+v - 1] },
  { id: "filter-point", label: "Ponto" },
  { id: "filter-type", label: "Tipo" },
  { id: "filter-fire", label: "Fogo" },
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
  const search = document.getElementById("filter-search");
  if (search?.value.trim()) {
    chips.push(`<button class="chip" data-id="filter-search" type="button">` +
      `<span class="chip__k">Busca:</span> <span class="chip__v">${escapeText(search.value.trim())}</span>` +
      `<span class="chip__x" aria-hidden="true">×</span></button>`);
  }
  box.innerHTML = chips.join("");
  box.style.display = chips.length ? "" : "none";
  box.querySelectorAll(".chip").forEach((btn) => {
    btn.onclick = () => {
      const s = document.getElementById(btn.dataset.id);
      if (s) {
        s.value = s.id === "filter-criterion" ? DEFAULT_CRITERION : "";
        if (s.id === "filter-search") s.classList.remove("is-selected");
      }
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
  renderMonthly(data, crit);
  renderScaled(data);
  renderAxes(data);
  renderTable(data);
  updateActiveFilters();
}

/* ===================== Consulta da planilha (tabela) ===================== */
const TABLE_BATCH = 50;
const TABLE = { data: [], rows: [], shown: TABLE_BATCH, key: "date", dir: -1, q: "" };

function currentCrit() { return document.getElementById("filter-criterion").value || DEFAULT_CRITERION; }
function sortVal(r, k) { return k === "date" ? r.date.getTime() : (r[k] ?? null); }
function cellNum(v, d) { return v == null ? "—" : fmtNum(v, d); }

function renderTable(data) {
  TABLE.data = data;
  TABLE.shown = TABLE_BATCH;
  tableScrollTop();
  drawTable();
}

function tableRows() {
  const q = TABLE.q.trim().toLocaleLowerCase("pt-BR");
  let rows = TABLE.data;
  if (q) {
    rows = rows.filter((r) => [r.fogo, r.ponto, r.tipo, fmtDate(r.date)]
      .some((v) => String(v).toLocaleLowerCase("pt-BR").includes(q)));
  }
  const { key, dir } = TABLE;
  return rows.slice().sort((a, b) => {
    const va = sortVal(a, key), vb = sortVal(b, key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string") return va.localeCompare(vb, "pt-BR", { numeric: true }) * dir;
    return (va - vb) * dir;
  });
}

function tableScrollTop() {
  document.querySelector("#data-section .table-wrap").scrollTop = 0;
}

function drawTable() {
  const rows = tableRows();
  TABLE.rows = rows;
  const slice = rows.slice(0, TABLE.shown);
  const crit = currentCrit();

  const body = document.getElementById("data-body");
  body.innerHTML = slice.length ? slice.map((r) => {
    const lim = r.domFreq != null ? limitAt(crit, r.domFreq) : null;
    const over = r.ppv != null && lim != null && r.ppv > lim;
    return `<tr${over ? ' class="is-over"' : ""}>` +
      `<td>${fmtDate(r.date)}</td><td>${escapeText(r.fogo || "—")}</td><td>${escapeText(r.ponto)}</td><td>${escapeText(r.tipo)}</td>` +
      `<td class="num">${cellNum(r.dist, 0)}</td><td class="num">${cellNum(r.carga, 1)}</td>` +
      `<td class="num">${cellNum(r.domFreq, 1)}</td><td class="num ppv">${cellNum(r.ppv, 2)}</td>` +
      `<td class="num">${cellNum(r.air, 1)}</td></tr>`;
  }).join("") : `<tr><td colspan="9" class="empty">Nenhum evento com os filtros atuais</td></tr>`;

  document.getElementById("table-info").textContent =
    `${fmtInt(rows.length)} registros · ` +
    (TABLE.shown >= rows.length ? "todos exibidos" : `exibindo ${fmtInt(slice.length)}`);

  document.querySelectorAll("#data-section th[data-key]").forEach((th) => {
    th.classList.toggle("is-sorted", th.dataset.key === TABLE.key);
    th.dataset.dir = th.dataset.key === TABLE.key ? (TABLE.dir > 0 ? "asc" : "desc") : "";
  });
}

function exportTableCsv() {
  const rows = tableRows();
  const dec = (v, d) => (v == null ? "" : v.toFixed(d).replace(".", ","));
  const head = ["Data", "ID desmonte", "Ponto", "Tipo", "Distância (m)", "Carga total (kg)", "Freq. dominante (Hz)", "PPV (mm/s)", "Airblast (dBL)", "Conformidade"];
  const crit = currentCrit();
  const lines = rows.map((r) => {
    const lim = r.domFreq != null ? limitAt(crit, r.domFreq) : null;
    const conf = r.ppv != null && lim != null ? (r.ppv <= lim ? "Abaixo" : "Acima") : "";
    return [fmtDate(r.date), r.fogo, r.ponto, r.tipo, dec(r.dist, 0), dec(r.carga, 1), dec(r.domFreq, 1), dec(r.ppv, 2), dec(r.air, 1), conf]
      .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";");
  });
  const csv = "﻿" + [head.join(";"), ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `sismografia_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function initTable() {
  document.getElementById("table-search").oninput = (e) => {
    TABLE.q = e.target.value;
    TABLE.shown = TABLE_BATCH;
    tableScrollTop();
    drawTable();
  };
  document.getElementById("table-export").onclick = exportTableCsv;
  document.querySelectorAll("#data-section th[data-key]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.key;
      if (TABLE.key === k) TABLE.dir *= -1;
      else { TABLE.key = k; TABLE.dir = (k === "date" || th.classList.contains("num")) ? -1 : 1; }
      TABLE.shown = TABLE_BATCH;
      tableScrollTop();
      drawTable();
    };
  });
  // Rolagem infinita: ao chegar perto do fim, carrega mais um lote
  const wrap = document.querySelector("#data-section .table-wrap");
  wrap.addEventListener("scroll", () => {
    if (TABLE.shown < TABLE.rows.length && wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 120) {
      TABLE.shown += TABLE_BATCH;
      drawTable();
    }
  });
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
    airOver > 0 ? `${fmtInt(airOver)} acima de ${nbrAir} dBL` : `Limite NBR: ${nbrAir} dBL`;
}




/* Rótulos de valor nas barras (padrão das lâminas Enaex). Só aparecem quando há espaço. */
function barLabel(color, anchor = "center", align = "center", offset = 0) {
  return {
    display: (ctx) => Number(ctx.dataset.data[ctx.dataIndex]) > 0,
    color,
    anchor,
    align,
    offset,
    font: { size: 11, weight: "600" },
    formatter: (v) => fmtNum(v, Number.isInteger(v) ? 0 : 1),
  };
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
    options: lineOpts("PPV (mm/s)", { plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 11 }, padding: 10 } } } }),
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
    options: lineOpts("Airblast (dBL)", { plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 11 }, padding: 10 } } } }),
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
        { label: "Abaixo do limite", data: bands.map((b) => b.count - b.over), backgroundColor: C.ink, borderRadius: 0, datalabels: barLabel("#ffffff", "center") },
        { label: "Acima do limite", data: bands.map((b) => b.over), backgroundColor: C.neutral, borderRadius: 0, datalabels: barLabel("#ffffff", "center") },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 11 }, padding: 10 } }, tooltip: tooltipCfg() },
      scales: { x: scaleTicks(), y: scaleY("Nº de eventos") },
    },
  });
}

function renderMonthly(data, crit) {
  const groups = {};
  data.forEach((r) => {
    if (r.ppv == null || r.domFreq == null) return;
    const g = (groups[monthKey(r)] = groups[monthKey(r)] || { ok: 0, over: 0 });
    if (r.ppv > limitAt(crit, r.domFreq)) g.over++; else g.ok++;
  });
  const keys = Object.keys(groups).sort();
  if (!keys.length) return buildChart("chart-monthly", null, emptyScatter());
  buildChart("chart-monthly", "bar", {
    type: "bar",
    data: {
      labels: keys.map(monthLabel),
      datasets: [
        { label: "Abaixo do limite", data: keys.map((k) => groups[k].ok), backgroundColor: C.ink, borderRadius: 0, stack: "m", datalabels: barLabel("#ffffff") },
        { label: "Acima do limite", data: keys.map((k) => groups[k].over), backgroundColor: C.neutral, borderRadius: 0, stack: "m", datalabels: barLabel("#ffffff") },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 10, font: { size: 11 }, padding: 14 } }, tooltip: tooltipCfg() },
      scales: { x: { ...scaleTicks(), stacked: true, grid: { display: false } }, y: { ...scaleY("Nº de eventos"), stacked: true } },
    },
  });
}



/* ===================== Cores por categoria de evento ===================== */
const TIPO_COLOR = {
  "Campanha completa": "#3C4148",
  "Produção": "#B40E16",
  "Ruído da comunidade": "#E0A100",
  "Pré-corte": "#2A9D8F",
  "Blocos, regularizações, etc": "#7A4EAB",
  "Não classificado": "#B8BCC2",
};
const TIPO_ORDER = Object.keys(TIPO_COLOR);

/* Uma série por categoria: a legenda vira filtro (clique para ocultar). */
function eventDatasets(recs, xf, yf) {
  const groups = {};
  recs.forEach((r) => { (groups[r.tipo] = groups[r.tipo] || []).push(r); });
  const order = TIPO_ORDER.filter((t) => groups[t]).concat(Object.keys(groups).filter((t) => !TIPO_COLOR[t]));
  return order.map((t) => ({
    type: "scatter",
    label: t,
    data: groups[t].map((r) => ({ x: xf(r), y: yf(r), rec: r })),
    backgroundColor: TIPO_COLOR[t] || "#B8BCC2",
    borderColor: "#ffffff",
    borderWidth: 0.6,
    pointRadius: 3.6,
    pointHoverRadius: 6,
    order: 3,
    isEvents: true,
  }));
}

function eventTooltip(label) {
  return tooltipCfg({
    filter: (it) => it.dataset.isEvents,
    callbacks: { title: () => "", label },
  });
}

function renderVF(data, crit) {
  const pts = data.filter((r) => r.ppv != null && r.domFreq != null && r.ppv > 0 && r.domFreq > 0);
  const datasets = eventDatasets(pts, (r) => r.domFreq, (r) => r.ppv);
  for (const [key, c] of Object.entries(CRITERIA)) {
    const sel = key === crit;
    datasets.push({
      type: "line", label: sel ? `${c.label} (critério)` : c.label,
      data: c.pts.map(([x, y]) => ({ x, y })),
      borderColor: c.color,
      borderWidth: sel ? 2.6 : 1.2,
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
        legend: { display: true, position: "bottom", labels: { color: C.text, usePointStyle: true, boxWidth: 8, font: { size: 11 }, padding: 14 } },
        tooltip: eventTooltip((it) => {
          const p = it.raw.rec;
          const lim = limitAt(crit, p.domFreq);
          return [
            p.tipo, `Ponto: ${p.ponto}`, `PPV: ${fmtNum(p.ppv, 2)} mm/s`,
            `Freq.: ${fmtNum(p.domFreq, 1)} Hz`, `Data: ${fmtDate(p.date)}`,
            p.ppv <= lim ? `✓ abaixo de ${CRITERIA[crit].short} (${fmtNum(lim, 1)} mm/s)` : `✗ acima de ${CRITERIA[crit].short} (${fmtNum(lim, 1)} mm/s)`,
          ];
        }),
      },
      scales: {
        x: { type: "logarithmic", min: 1, max: 250,
          title: { display: true, text: "Frequência dominante (Hz)", color: C.text, font: { size: 11, weight: "600" } },
          ticks: { color: C.text, font: { size: 10 } }, grid: { color: C.grid } },
        y: { type: "logarithmic", min: 0.05, max: 100,
          title: { display: true, text: "PPV (mm/s)", color: C.text, font: { size: 11, weight: "600" } },
          ticks: { color: C.text, font: { size: 10 }, callback: (v) => Number.isInteger(v) ? v : "" },
          grid: { color: C.grid } },
      },
    },
  });
}

function renderPPV(data) {
  const pts = data.filter((r) => r.ppv != null);
  if (!pts.length) return buildChart("chart-ppv", null, emptyScatter());
  buildChart("chart-ppv", null, {
    data: { datasets: eventDatasets(pts, (r) => r.date.getTime(), (r) => r.ppv) },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, usePointStyle: true, boxWidth: 8, font: { size: 11 }, padding: 14 } },
        tooltip: eventTooltip((it) => {
          const r = it.raw.rec;
          return [`Data: ${fmtDate(r.date)}`, `Ponto: ${r.ponto}`, `PPV: ${fmtNum(r.ppv, 2)} mm/s`, `Freq.: ${fmtNum(r.domFreq, 1)} Hz`, r.tipo];
        }),
      },
      scales: {
        x: { type: "linear", ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 8, callback: (v) => fmtAxisDate(v) }, grid: { color: C.grid } },
        y: { title: { display: true, text: "PPV (mm/s)", color: C.text, font: { size: 11, weight: "600" } }, ticks: { color: C.text, font: { size: 10 } }, grid: { color: C.grid }, beginAtZero: true },
      },
    },
  });
}

function renderAir(data) {
  const pts = data.filter((r) => r.air != null);
  if (!pts.length) return buildChart("chart-air", null, emptyScatter());
  const xs = pts.map((r) => r.date.getTime());
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const datasets = eventDatasets(pts, (r) => r.date.getTime(), (r) => r.air);
  AIRBLAST_REFS.forEach((ref, i) => {
    datasets.push({
      type: "line", label: ref.label,
      data: [{ x: xmin, y: ref.dBL }, { x: xmax, y: ref.dBL }],
      borderColor: ref.color, borderWidth: ref.solid ? 2 : 1.2,
      borderDash: ref.solid ? [] : [6, 4], pointRadius: 0, fill: false, order: 1 + i,
    });
  });
  buildChart("chart-air", null, {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, usePointStyle: true, boxWidth: 8, font: { size: 11 }, padding: 12 } },
        tooltip: eventTooltip((it) => {
          const r = it.raw.rec;
          return [`Data: ${fmtDate(r.date)}`, `Ponto: ${r.ponto}`, `Airblast: ${fmtNum(r.air, 1)} dBL`, r.air > 134 ? "✗ acima do limite NBR (134 dBL)" : "✓ abaixo do limite NBR", r.tipo];
        }),
      },
      scales: {
        x: { type: "linear", ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 8, callback: (v) => fmtAxisDate(v) }, grid: { color: C.grid } },
        y: { title: { display: true, text: "Airblast — dBL pico (Linear)", color: C.text, font: { size: 11, weight: "600" } }, ticks: { color: C.text, font: { size: 10 } }, grid: { color: C.grid } },
      },
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
  if (head) head.textContent = `${pts.length} eventos · v = ${fmtNum(reg.k, 0)}·DE^−${fmtNum(reg.beta, 2)} · R² = ${fmtNum(reg.r2, 2)}`;

  const datasets = eventDatasets(pts, (r) => r.de, (r) => r.ppv);
  datasets.push({ type: "line", label: "Regressão v = K·DE^−β", data: line, borderColor: C.neutral, borderWidth: 2.2, pointRadius: 0, fill: false, order: 0 });
  buildChart("chart-scaled", null, {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, usePointStyle: true, boxWidth: 8, font: { size: 11 }, padding: 12 } },
        tooltip: eventTooltip((it) => {
          const r = it.raw.rec;
          return [`Ponto: ${r.ponto}`, `Data: ${fmtDate(r.date)}`, `DE: ${fmtNum(r.de, 1)} m/√kg`, `PPV: ${fmtNum(r.ppv, 2)} mm/s`, `Q: ${fmtNum(r.mic, 0)} kg · R: ${fmtNum(r.dist, 0)} m`];
        }),
      },
      scales: {
        x: { type: "logarithmic", title: { display: true, text: "Distância escalonada DE (m/√kg)", color: C.text, font: { size: 11, weight: "600" } }, ticks: { color: C.text, font: { size: 10 } }, grid: { color: C.grid } },
        y: { type: "logarithmic", min: 0.01, title: { display: true, text: "PPV (mm/s)", color: C.text, font: { size: 11, weight: "600" } }, ticks: { color: C.text, font: { size: 10 }, callback: (v) => Number.isInteger(v) ? v : "" }, grid: { color: C.grid } },
      },
    },
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
        { label: "PPV máx. (mm/s)", data: entries.map((e) => e.max), backgroundColor: C.neutral, borderRadius: 0, barPercentage: 0.62, categoryPercentage: 0.8,
          datalabels: { display: true, anchor: "end", align: "right", offset: 4, color: C.ink, font: { size: 10, weight: "600" }, formatter: (v) => fmtNum(v, 2) } },
        { label: "PPV p95 (mm/s)", data: entries.map((e) => e.p95), backgroundColor: C.grey, borderRadius: 0, barPercentage: 0.62, categoryPercentage: 0.8,
          datalabels: { display: false } },
      ],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { right: 40 } },
      plugins: { legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 10, font: { size: 11 }, padding: 14 } }, tooltip: tooltipCfg() },
      scales: { x: scaleY("PPV (mm/s)"), y: { ...scaleTicks(), ticks: { color: C.text, font: { size: 10 }, autoSkip: false }, grid: { display: false } } },
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
      [`Velocidade — ${d.label}`, Object.keys(gV).sort(), (k) => mean(gV[k]), "mm/s", 2],
      [`Frequência — ${d.label}`, Object.keys(gF).sort(), (k) => mean(gF[k]), "Hz", 1],
    ];
    for (const [title, keys, valFn, yTitle, dec] of series) {
      const card = document.createElement("div");
      card.className = "extra-card";
      const id = "extra-" + d.key + "-" + (yTitle === "Hz" ? "f" : "v");
      card.style.borderTop = `3px solid ${d.color}`;
      card.innerHTML = `<p class="extra-card__title"><span class="extra-card__swatch" style="background:${d.color}"></span>${title}</p><div class="extra-card__canvas"><canvas id="${id}"></canvas></div>`;
      container.appendChild(card);
      if (!keys.length) continue;
      buildChart(id, "line", {
        type: "line",
        data: {
          labels: keys.map(monthLabel),
          datasets: [{
            data: keys.map(valFn), borderColor: d.color, backgroundColor: d.color + "1f",
            borderWidth: 2.2, pointRadius: 2.5, pointBackgroundColor: d.color, tension: 0.35, fill: true,
            datalabels: {
              display: (ctx) => ctx.dataIndex === ctx.dataset.data.length - 1,
              anchor: "end", align: "top", offset: 4, color: d.color,
              font: { size: 10, weight: "600" }, formatter: (v) => fmtNum(v, dec),
            },
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          layout: { padding: { top: 14, right: 18 } },
          plugins: { legend: { display: false }, tooltip: tooltipCfg({ callbacks: { label: (it) => fmtNum(it.parsed.y, dec) + " " + yTitle } }) },
          scales: {
            x: { ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 6, autoSkip: true }, grid: { display: false }, border: { display: false } },
            y: { ticks: { color: C.text, font: { size: 10 } }, grid: { color: C.grid }, border: { display: false }, title: { display: true, text: yTitle, color: C.text, font: { size: 10 } } },
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
function scaleTicks() { return { ticks: { color: C.text, font: { size: 10 }, maxRotation: 45, autoSkip: true }, border: { color: C.grid } }; }
function scaleY(title) {
  return {
    title: { display: !!title, text: title, color: C.text, font: { size: 11, weight: "600" } },
    ticks: { color: C.text, font: { size: 10 } }, grid: { color: C.grid }, border: { color: C.grid },
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
  Chart.defaults.font.size = 11;
  Chart.defaults.color = "#404040";
  Chart.defaults.borderColor = "rgba(0,0,0,0.10)";
  if (window.ChartDataLabels) {
    Chart.register(ChartDataLabels);
    Chart.defaults.set("plugins.datalabels", { display: false });
  }
  Object.assign(Chart.defaults.plugins.tooltip, tooltipBase());
  initTable();
  loadSheet().catch((e) => console.error(e));
  setInterval(() => loadSheet().catch(() => {}), 10 * 60 * 1000);
});
