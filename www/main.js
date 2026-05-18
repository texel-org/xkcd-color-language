import * as Color from "@texel/color";
import { html, render } from "lit-html";
import { getUserMap, loadData } from "../src/util/json";
import {
  buildColorCache,
  closestPointIndex,
  convertWithCache,
  DEFAULT_AB_FACTOR,
  deltaEOK2Squared,
  geometricMedian,
  nextGaussianBoxMuller,
  robustCentroid,
} from "../src/util/gaussian";
import { findForeground } from "../src/util/data";
import { PCA } from "../src/util/pca";
import dataUrl from "../data/xkcd/answers.compact.json?url";
import * as IDB from "idb-keyval";

const IDB_PATH = "xkcd-data-json";

const BATCH_SIZE = 1000;
const CURATED_TERMS = false;
const MIN_USER_COUNT = 4;
const GAUSSIAN_SAMPLE_COUNT = 64;
const PCA_CANVAS_SIZE = 192;
const SIGMA_EXTENT = 2.5;
const GAMUT_MAP = Color.MapToCuspL;
const MAX_TERM_COUNT = 15000;

const views = {
  loading: document.getElementById("loading-view"),
  overview: document.getElementById("overview-view"),
  detail: document.getElementById("detail-view"),
  user: document.getElementById("user-view"),
};
let overviewDirty = true;

function setActiveView(name) {
  for (const key of Object.keys(views)) {
    views[key].hidden = key !== name;
  }
}

const FILTER_KEY_MAP = { 1: "mad", 2: "euclidean", 3: "none" };

let data = [];
let colorCache = null; // shared cache reused across filter modes
let termsByFilter = {}; // lazy: { mad?: [...], euclidean?: [...], none?: [...] }
let recordsByFilter = {}; // lazy: { mad?: Map, euclidean?: Map, none?: Map }
let currentFilter = "mad";
let terms = [];
let byName = new Map();
let userMap = new Map();
let currentName = null;
let votesShown = BATCH_SIZE;

function getTerms(filter) {
  if (!termsByFilter[filter]) {
    termsByFilter[filter] = convertWithCache(data, colorCache, {
      filter,
    });
  }
  return termsByFilter[filter];
}

function getRecords(filter) {
  if (recordsByFilter[filter]) return recordsByFilter[filter];
  if (filter === "none") {
    const m = new Map();
    for (const d of data) {
      const arr = m.get(d.name);
      if (arr) arr.push(d);
      else m.set(d.name, [d]);
    }
    recordsByFilter.none = m;
  } else {
    recordsByFilter[filter] = new Map(
      getTerms(filter).map((t) => [t.name, t.filteredRecords]),
    );
  }
  return recordsByFilter[filter];
}

let colorPicker = {
  active: false,
  hex: "#888888",
  oklab: null,
  threshold: 0.2,
};
let swatchNodes = [];
let termVisible = [];
let colorFilterFramePending = false;

let simMode = "gaussian";
let simCache = null; // { name, components, zSamples, samples }
let statsCache = null; // { name, filter, count, stats }
let gaussianScale = 1;
let pcaSlider = 0; // [-1, 1] fraction of SIGMA_EXTENT * sigma3
let pcaDrawPending = false;

let overviewScroll = 0;
let prevRoute = { view: "overview" };

function readHash() {
  const h = location.hash;
  return h.startsWith("#") ? decodeURIComponent(h.slice(1)) : "";
}

function parseRoute() {
  const h = readHash();
  if (h.startsWith("/user/")) return { view: "user", id: h.slice(6) };
  if (h) return { view: "term", name: h };
  return { view: "overview" };
}

function oklabToSRGB(oklab) {
  return Color.gamutMapOKLCH(
    Color.convert(oklab, Color.OKLab, Color.OKLCH),
    Color.sRGBGamut,
    Color.sRGB,
    undefined,
    GAMUT_MAP,
  );
}

function oklabToHex(oklab) {
  return Color.RGBToHex(oklabToSRGB(oklab));
}

function regenZSamples() {
  const z = new Array(GAUSSIAN_SAMPLE_COUNT);
  for (let i = 0; i < GAUSSIAN_SAMPLE_COUNT; i++) {
    z[i] = [
      nextGaussianBoxMuller(0, 1),
      nextGaussianBoxMuller(0, 1),
      nextGaussianBoxMuller(0, 1),
    ];
  }
  return z;
}

function samplesFromZ(term, components, zSamples, scale) {
  return zSamples.map((z) => {
    const out = [term.mean[0], term.mean[1], term.mean[2]];
    for (let i = 0; i < components.length; i++) {
      const c = components[i];
      const s = z[i] * c.sigma * scale;
      out[0] += s * c.vector[0];
      out[1] += s * c.vector[1];
      out[2] += s * c.vector[2];
    }
    return oklabToHex(out);
  });
}

function ensureStats(term) {
  if (
    statsCache &&
    statsCache.name === term.name &&
    statsCache.filter === currentFilter
  ) {
    return statsCache;
  }
  const records = byName.get(term.name) || [];
  const oklabs = records.map((r) =>
    Color.convert(Color.hexToRGB(r.hex), Color.sRGB, Color.OKLab),
  );
  const stats = [];
  if (oklabs.length > 0) {
    const meanOklab = term.mean;
    const coordOklab = robustCentroid(oklabs);
    const geomOklab = geometricMedian(oklabs);
    const medoidIdx = closestPointIndex(oklabs, geomOklab);
    stats.push(
      { label: "mean", hex: oklabToHex(meanOklab) },
      { label: "geom. median", hex: oklabToHex(geomOklab) },
      { label: "medoid", hex: records[medoidIdx].hex },
      { label: "coord. median", hex: oklabToHex(coordOklab) },
    );
  }
  statsCache = {
    name: term.name,
    filter: currentFilter,
    count: oklabs.length,
    stats,
  };
  return statsCache;
}

function ensureSim(term) {
  if (!simCache || simCache.name !== term.name) {
    const components = PCA(term.cov);
    const zSamples = regenZSamples();
    simCache = {
      name: term.name,
      components,
      zSamples,
      samples: samplesFromZ(term, components, zSamples, gaussianScale),
    };
    pcaSlider = 0;
  }
  return simCache;
}

function drawPCACanvas() {
  pcaDrawPending = false;
  if (!simCache) return;
  const term = terms.find((t) => t.name === simCache.name);
  if (!term) return;
  const canvas = document.getElementById("pca-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const [pc1, pc2, pc3] = simCache.components;
  const z3 = pcaSlider * SIGMA_EXTENT * pc3.sigma;
  const v1 = pc1.vector;
  const v2 = pc2.vector;
  const v3 = pc3.vector;
  const m = term.mean;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      const x = (px / (w - 1)) * 2 - 1;
      const y = -((py / (h - 1)) * 2 - 1);
      const a1 = x * SIGMA_EXTENT * pc1.sigma;
      const a2 = y * SIGMA_EXTENT * pc2.sigma;
      const oklab = [
        m[0] + a1 * v1[0] + a2 * v2[0] + z3 * v3[0],
        m[1] + a1 * v1[1] + a2 * v2[1] + z3 * v3[1],
        m[2] + a1 * v1[2] + a2 * v2[2] + z3 * v3[2],
      ];
      const srgb = oklabToSRGB(oklab);
      d[i] = Math.round(srgb[0] * 255);
      d[i + 1] = Math.round(srgb[1] * 255);
      d[i + 2] = Math.round(srgb[2] * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function schedulePCADraw() {
  if (pcaDrawPending) return;
  pcaDrawPending = true;
  requestAnimationFrame(drawPCACanvas);
}

function onModeChange(e) {
  simMode = e.target.value;
  update();
}

function onRegenerate(term) {
  const sim = ensureSim(term);
  sim.zSamples = regenZSamples();
  sim.samples = samplesFromZ(term, sim.components, sim.zSamples, gaussianScale);
  update();
}

function onGaussianScale(e) {
  gaussianScale = +e.target.value;
  const label = document.getElementById("gauss-scale-value");
  if (label) label.textContent = formatScale(gaussianScale);
  if (!simCache) return;
  const term = terms.find((t) => t.name === simCache.name);
  if (!term) return;
  simCache.samples = samplesFromZ(
    term,
    simCache.components,
    simCache.zSamples,
    gaussianScale,
  );
  const nodes = document.querySelectorAll(".sim__sample");
  for (let i = 0; i < nodes.length && i < simCache.samples.length; i++) {
    const hex = simCache.samples[i];
    nodes[i].style.background = hex;
    nodes[i].title = hex;
  }
}

function onPCASlider(e) {
  pcaSlider = +e.target.value;
  const label = document.getElementById("pca-slider-value");
  if (label) label.textContent = formatSigma(pcaSlider);
  schedulePCADraw();
}

function formatSigma(frac) {
  const v = frac * SIGMA_EXTENT;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}σ`;
}

function formatScale(s) {
  return `${s.toFixed(2)}×`;
}

function labeledSwatch(item, linkable) {
  const style = `background:${item.hex};color:${findForeground(item.hex)}`;
  const title = `${item.name} — ${item.hex}${
    item.votes != null ? ` (${item.votes} votes)` : ""
  }`;
  return linkable
    ? html`
        <a
          class="swatch swatch--labeled"
          style=${style}
          href="#${encodeURIComponent(item.name)}"
          title=${title}
        >
          <span class="label">${item.name}</span>
        </a>
      `
    : html`
        <div class="swatch swatch--labeled" style=${style} title=${title}>
          <span class="label">${item.name}</span>
        </div>
      `;
}

function labeledGrid(items, { linkable = true } = {}) {
  return html`
    <div class="grid grid--terms">
      ${items.map((i) => labeledSwatch(i, linkable))}
    </div>
  `;
}

function updateColorPickerOklab() {
  const srgb = Color.hexToRGB(colorPicker.hex);
  colorPicker.oklab = Color.convert(srgb, Color.sRGB, Color.OKLab);
}

function onColorFilterToggle(e) {
  colorPicker.active = e.target.checked;
  applyColorFilter();
}

function onColorFilterInput(e) {
  colorPicker.hex = e.target.value;
  updateColorPickerOklab();
  if (colorPicker.active) scheduleColorFilter();
}

function onColorFilterThresholdInput(e) {
  colorPicker.threshold = +e.target.value;
  if (colorPicker.active) scheduleColorFilter();
}

function scheduleColorFilter() {
  if (colorFilterFramePending) return;
  colorFilterFramePending = true;
  requestAnimationFrame(() => {
    colorFilterFramePending = false;
    applyColorFilter();
  });
}

function applyColorFilter() {
  if (!swatchNodes.length) return;
  const active = colorPicker.active && colorPicker.oklab;
  const target = colorPicker.oklab;
  const thresholdSq = colorPicker.threshold * colorPicker.threshold;
  for (let i = 0; i < terms.length; i++) {
    const visible =
      !active ||
      deltaEOK2Squared(terms[i].mean, target, DEFAULT_AB_FACTOR) <= thresholdSq;
    if (visible !== termVisible[i]) {
      swatchNodes[i].style.display = visible ? "" : "none";
      termVisible[i] = visible;
    }
  }
}

function overview() {
  return html`
    <header>
      <div class="overview__title">
        <h1>xkcd color language</h1>
        <p>
          ${terms.length} color terms · filter: ${currentFilter} (1=mad
          2=euclidean 3=none)
        </p>
      </div>
      <div class="color-filter">
        <label>
          <input
            type="checkbox"
            ?checked=${colorPicker.active}
            @change=${onColorFilterToggle}
          />
          filter
        </label>
        <input
          type="color"
          class="color-filter__input"
          .value=${colorPicker.hex}
          @input=${onColorFilterInput}
          @change=${onColorFilterInput}
        />
        <input
          type="range"
          class="color-filter__slider"
          min="0.001"
          max="0.5"
          step="0.001"
          .value=${String(colorPicker.threshold)}
          @input=${onColorFilterThresholdInput}
        />
      </div>
    </header>
    ${labeledGrid(terms, { linkable: true })}
  `;
}

function userView(rawId) {
  if (!userMap.size) userMap = getUserMap(data);
  const id = Number(rawId);
  const indices = Number.isFinite(id) ? userMap.get(id) || [] : [];
  const items = indices.map((idx) => data[idx]);
  return html`
    <header>
      <a class="back" href="#">← back</a>
      <h1>user ${rawId}</h1>
      <p>${items.length} color${items.length === 1 ? "" : "s"}</p>
    </header>
    ${items.length ? labeledGrid(items, { linkable: false }) : ""}
  `;
}

function logVote(v) {
  console.log([v.user, parseInt(v.hex.slice(1), 16), v.name]);
}

function votesColumn(visible, remaining) {
  return html`
    <div class="grid grid--votes">
      ${visible.map(
        (v) => html`
          <span
            class="swatch"
            style="background:${v.hex}"
            title="${v.hex}"
            @click=${() => logVote(v)}
          ></span>
        `,
      )}
    </div>
    ${remaining > 0
      ? html`
          <button class="load-more" @click=${loadMore}>
            load ${Math.min(BATCH_SIZE, remaining)} more (${remaining}
            remaining)
          </button>
        `
      : ""}
  `;
}

function gaussianBody(term) {
  const sim = ensureSim(term);
  const [pc1, pc2, pc3] = sim.components;
  return html`
    <div class="sim__body">
      <label class="sim__slider">
        <span>σ scale</span>
        <input
          type="range"
          min="0"
          max="3"
          step="0.05"
          .value=${String(gaussianScale)}
          @input=${onGaussianScale}
        />
        <span id="gauss-scale-value" class="sim__slider-value"></span>
      </label>
      <div class="grid grid--samples">
        ${sim.samples.map(
          (h) => html`
            <span
              class="swatch sim__sample"
              style="background:${h}"
              title="${h}"
            ></span>
          `,
        )}
      </div>
      <p class="sim__note">
        σ₁ ${pc1.sigma.toFixed(3)} · σ₂ ${pc2.sigma.toFixed(3)} · σ₃
        ${pc3.sigma.toFixed(3)}
      </p>
    </div>
  `;
}

function pcaBody(term) {
  ensureSim(term);
  return html`
    <div class="sim__body">
      <label class="sim__slider">
        <span>pc3</span>
        <input
          type="range"
          min="-1"
          max="1"
          step="0.01"
          .value=${String(pcaSlider)}
          @input=${onPCASlider}
        />
        <span id="pca-slider-value" class="sim__slider-value"></span>
      </label>
      <canvas
        id="pca-canvas"
        class="sim__canvas"
        width="${PCA_CANVAS_SIZE}"
        height="${PCA_CANVAS_SIZE}"
      ></canvas>
      <p class="sim__note">
        disc = pc1 × pc2 around mean · slider = pc3 offset (±${SIGMA_EXTENT}σ)
      </p>
    </div>
  `;
}

function statsBody(term) {
  const { stats, count } = ensureStats(term);
  return html`
    <div class="sim__body">
      <div class="grid grid--stats">
        ${stats.map(
          (s) => html`
            <div
              class="swatch swatch--labeled"
              style="background:${s.hex};color:${findForeground(s.hex)}"
              title="${s.label} — ${s.hex}"
            >
              <span class="label">${s.label}<br /><code>${s.hex}</code></span>
            </div>
          `,
        )}
      </div>
      <p class="sim__note">
        central tendency estimators · ${count} point${count === 1 ? "" : "s"}
      </p>
    </div>
  `;
}

function simulationColumn(term) {
  return html`
    <aside class="sim">
      <div class="sim__head">
        <select class="sim__mode" @change=${onModeChange}>
          <option value="gaussian" ?selected=${simMode === "gaussian"}>
            gaussian
          </option>
          <option value="pca" ?selected=${simMode === "pca"}>pca</option>
          <option value="stats" ?selected=${simMode === "stats"}>stats</option>
        </select>
        ${simMode === "gaussian"
          ? html`
              <button class="btn" @click=${() => onRegenerate(term)}>
                regenerate
              </button>
            `
          : ""}
      </div>
      ${simMode === "gaussian"
        ? gaussianBody(term)
        : simMode === "pca"
          ? pcaBody(term)
          : statsBody(term)}
    </aside>
  `;
}

function detail(name) {
  if (currentName !== name) {
    currentName = name;
    votesShown = BATCH_SIZE;
  }
  const term = terms.find((t) => t.name === name);
  const votes = byName.get(name) || [];
  const visible = votes.slice(0, votesShown);
  const remaining = votes.length - visible.length;
  return html`
    <header>
      <a class="back" href="#">← back</a>
      <h1>${name}</h1>
      <p>
        mean
        <span class="chip" style="background:${term?.hex}"></span>
        <code>${term?.hex}</code>
        · ${votes.length}
        votes${remaining > 0 ? html` · showing ${visible.length}` : ""} ·
        filter: ${currentFilter}
      </p>
    </header>
    <div class="detail">
      <div class="detail__votes">${votesColumn(visible, remaining)}</div>
      <div class="detail__sim">${term ? simulationColumn(term) : ""}</div>
    </div>
  `;
}

function loadMore() {
  votesShown += BATCH_SIZE;
  update();
}

function paintSimLabels() {
  const g = document.getElementById("gauss-scale-value");
  if (g) g.textContent = formatScale(gaussianScale);
  const p = document.getElementById("pca-slider-value");
  if (p) p.textContent = formatSigma(pcaSlider);
}

async function update() {
  const route = parseRoute();
  const inTerm = route.view === "term" && byName.has(route.name);
  if (!inTerm) currentName = null;

  if (route.view === "user") {
    render(userView(route.id), views.user);
    setActiveView("user");
  } else if (inTerm) {
    render(detail(route.name), views.detail);
    setActiveView("detail");
  } else {
    if (overviewDirty) {
      render(overview(), views.overview);
      overviewDirty = false;
      swatchNodes = Array.from(
        views.overview.querySelectorAll(".grid--terms .swatch"),
      );
      termVisible = new Array(terms.length).fill(true);
      applyColorFilter();
    }
    setActiveView("overview");
  }
  if (inTerm) paintSimLabels();
  if (inTerm && simMode === "pca") schedulePCADraw();
}

function setFilter(next) {
  if (currentFilter === next) return;
  currentFilter = next;
  terms = getTerms(next);
  byName = getRecords(next);
  simCache = null;
  statsCache = null;
  overviewDirty = true;
  votesShown = BATCH_SIZE;
  update();
}

function onKeyDown(e) {
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const t = document.activeElement;
  if (
    t &&
    (t.tagName === "INPUT" ||
      t.tagName === "SELECT" ||
      t.tagName === "TEXTAREA")
  ) {
    return;
  }
  const filter = FILTER_KEY_MAP[e.key];
  if (filter) {
    e.preventDefault();
    setFilter(filter);
    return;
  }
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const route = parseRoute();
  if (route.view !== "term") return;
  const idx = terms.findIndex((x) => x.name === route.name);
  if (idx < 0) return;
  const next = idx + (e.key === "ArrowRight" ? 1 : -1);
  if (next < 0 || next >= terms.length) return;
  e.preventDefault();
  location.hash = encodeURIComponent(terms[next].name);
}

async function onHashChange() {
  if (prevRoute.view === "overview") overviewScroll = window.scrollY;
  const newRoute = parseRoute();
  await update();
  if (newRoute.view === "overview") {
    window.scrollTo(0, overviewScroll);
  } else {
    window.scrollTo(0, 0);
  }
  prevRoute = newRoute;
}

async function main() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  // const prevData = await IDB.get(IDB_PATH);
  // if (prevData) {
  //   data = prevData;
  // } else {
  data = await loadData(dataUrl);
  // await IDB.set(IDB_PATH, data);
  // }
  colorCache = buildColorCache(data, {
    minUsers: MIN_USER_COUNT,
    curated: CURATED_TERMS,
    maxCount: MAX_TERM_COUNT,
  });
  console.log("Total Colors:", colorCache.length);
  // colorCache = colorCache.slice(-2500);
  // colorCache.reverse();
  // colorCache = colorCache.slice(0, 5000);
  terms = getTerms(currentFilter);
  byName = getRecords(currentFilter);
  updateColorPickerOklab();
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("keydown", onKeyDown);
  await update();
  prevRoute = parseRoute();
}

main();

window.reset = async () => {
  await IDB.del(IDB_PATH);
  console.log("reset");
};

function specialSet() {
  return new Set([
    "tin", // recheck
    "tiger",
    "soup",
    "mojito",
    "air",
    "piggy",
    "milk",
    "sewer",
    "victoria",
    "rhino",
    "carbon",
    "foundation",
    "moleskin",
    "bright grass",
    "light wood",
    "gray glue",
    "orchard",
    "blue and green",
    "other blue",
    "straight purple",
    "nay blue",
    "pink light",
    "irish",
    "amarelo",
    "paisley green",
    "manky green",
    "tundra",
    "purply white",
    "bulbasaur green",
    "chicken",
    "parma",
    "blastoise blue",
    "yet another shade of green",
    "shade of pink",
    "limer",
    "tanned",
    "white brown",
    "clouds",
    "java",
    "purple or blue",
    "other purple",
    "pudding",
    "moldy",
    "loam",
    "ground",
    "hemlock",
    "secondary green",
    "earth tone",
    "porpoise",
    "tomato bisque",
    "mojave",
    "coffee with milk",
    "bourgogne",
    "summer",
    "blue ciel",
    "olive oil",
    "maraschino",
    "apple blue sea green",
    "html blue",
    "ocean depths",
    "green light blue",
    "martian",
    "sand paper",
    "fluorescent",
    "cadmium",
    "flush",
    "gatorade",
    "kind of orange",
    "not black",
    "not quite purple",
    "bathroom tile",
    "doctors office green",
    "hospital walls",
    "mute pink",
    "cherry wood",
    "classic green",
    "blue velvet",
    "cream purple",
    "grunge green",
    "bright dark green",
    "lightest purple",
    "non photo blue",
    "desert storm",
    "dark off white",
    "horrible blue",
    "columbia",
    "flower blue",
    "bathroom blue",
    "kentucky blue",
    "sly blue",
    "spring purple",
    "darker pastel green",
    "spring sky blue",
    "dark green forest green",
    "dark marigold",
    "default green",
    "dull sky",
    "purple heather",
    "forest floor",
    "grape ape",
    "blue jeans blue",
    "calm purple",
    "flaming purple",
    "parrot",
    "regular purple",
    "post it",
    "windows desktop",
    "ups",
    "crayon",
    "darker",
    "windows 95 desktop",
    "alien",
    "wizard purple",
    "blue and purple",
    "brain",
    "squirrel",
    "brown bear",
    "omg green",
    "blue green green",
    "not pink",
    "not quite navy",
    "batman",
    "yet another shade of blue",
    "orange light",
    "brown light",
    "jean",
    "noir",
    "silk",
    "shadow",
    "chlorine",
    "mars",
    "bread",
    "haze",
    "gravy",
    "plume",
    "valentine",
    "sunburst",
    "peru",
    "natural",
    "bole",
    "savannah",
    "tinky winky",
    "midori",
    "mediterranean",
    "not purple",
    "full green",
    "bear",
    "evening",
    "radioactive",
    "yoshi",
    "light blur",
    "robin hood",
    "windows 95 background",
    "ciel",
    "cold",
    "powder",
    "mermaid",
    "teil",
    "shade of purple",
    "sunny",
    "blues",
    "tiffany",
    "royalty",
    "maroon 5",
    "poison",
    "electric",
    "flora",
    "paper",
    "link green",
    "too pink",
    "pimpin purple",
    "sort of green",
    "mostly green",
    "pretty pink",
    "purple people eater",
    "pale dark pink",
    "pale dark purple",
    "really purple",
    "pink pink",
    "rain",
    "chalkboard",
    "turf",
    "lemonade",
    "windows",
    "delicious",
    "fir",
    "yolk",
    "dawn",
    "raf blue",
    "hydrangea",
    "marmalade",
    "shrimp",
    "brownie",
    "envy",
    "syringa",
    "liche purple",
    "creamsicle orange",
    "creamy",
    "margarita",
    "jaune",
    "flower",
    "baby",
    "tortoise",
    "inchworm",
    "tumbleweed",
    "opaque green",
    "bluegrass",
    "ubuntu",
    "corn blue",
    "meat",
    "shark",
    "sewage",
    "yellow with a bit of green",
    "blue or purple",
    "different blue",
    "candy",
    "highlighter",
    "lizard",
    "scrubs",
    "other green",
    "bray",
    "ghost",
    "rot",
    "purplink",
    "ceil",
    "money",
    "dusty",
    "white purple",
    "white gray",
    "sickly",
    "leafy",
    "new leaf",
    "rosemary",
    "maple",
    "biscuit",
    "king blue",
    "rojo",
    "hospital",
    "mould",
    "swimming pool",
    "tuna",
    "sierra",
    "kind of green",
    "not blue",
    "dinosaur",
    "band aid",
    "different green",
    "cream orange",
    "mute green",
    "uniform blue",
    "morado",
    "horrid",
    "tile",
    "metal",
    "myrtle",
    "han purple",
    "phthalo blue",
    "cool",
    "tongue",
    "shade of green",
    "blue with a hint of green",
    "kinda green",
    "jungle",
    "fake green",
    "musk",
    "fish",
    "odd green",
    "chocolate milk",
    "green light",
    "smurf",
    "salad",
    "orange orange",
    "love",
    "violent",
    "tree",
    "frog",
    "pool",
    "gris",
    "windows 95",
    "rgb blue",
    "normal blue",
    "purple purple",
    "ultra violet",
    "standard green",
    "gray gray",
    "punk",
    "overcast",
    "macaroni",
    "papaya",
    "pumpkin pie",
    "bittersweet",
    "violent purple",
    "violent pink",
    "muddy",
    "plue",
    "rgb green",
    "cafe",
    "glue",
    "latte",
    "neutral",
    "grown",
    "pastel",
    "dull",
    "vert",
    "grue",
    "pig",
    "burnt",
    "camouflage",
    "spring",
    "turtle",
    "bright",
    "light",
    "lily",
    "sunset",
    "elephant",
    "water",
    "white green",
    "pure green",
    "smoke",
    "solid blue",
    "light black",
    "icky",
    "slime",
  ]);
}
