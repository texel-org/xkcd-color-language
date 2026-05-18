// =============================================================================
// color-name-stats.js
// Analyse a list of color-name entries with shape:
//   { name, colors: [{ srgb, oklab }], votes, userVotes, mean, cov }
// All distance/spread is computed in OKLab, which is roughly perceptually uniform.
// =============================================================================

// ----- small linear-algebra helpers ------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  Frequencies,
  getNameMap,
  getUserMap,
  loadDataFromJSON,
} from "./util/json.js";
import { convert, deltaEOK2 } from "./util/gaussian.js";
import { createReadStream, writeFileSync } from "node:fs";
import csv from "csv-parser";
import SpellChecker from "fast-spell";

const src = await readFile("data/xkcd/answers.compact.json", "utf8");
const rows = JSON.parse(src);

const dist3sq = (a, b) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const dist3 = (a, b) => Math.sqrt(dist3sq(a, b));
const trace3 = (m) => m[0][0] + m[1][1] + m[2][2];

function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

// Eigenvalues of a 3×3 symmetric matrix, largest-first (closed form).
function eigvals3sym(M) {
  const p1 = M[0][1] ** 2 + M[0][2] ** 2 + M[1][2] ** 2;
  if (p1 < 1e-30) return [M[0][0], M[1][1], M[2][2]].sort((a, b) => b - a);
  const q = trace3(M) / 3;
  const p2 =
    (M[0][0] - q) ** 2 + (M[1][1] - q) ** 2 + (M[2][2] - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B = [
    [(M[0][0] - q) / p, M[0][1] / p, M[0][2] / p],
    [M[1][0] / p, (M[1][1] - q) / p, M[1][2] / p],
    [M[2][0] / p, M[2][1] / p, (M[2][2] - q) / p],
  ];
  const r = Math.max(-1, Math.min(1, det3(B) / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  return [e1, e2, e3].sort((a, b) => b - a);
}

// OKLab -> sRGB hex (for console-printing). Clamps out-of-gamut.
function oklabToHex([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3,
    m = m_ ** 3,
    s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const g = (c) => {
    c = Math.max(0, Math.min(1, c));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };
  return (
    "#" +
    lin
      .map((c) =>
        Math.round(g(c) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

// ----- per-term statistics ---------------------------------------------------

// RMS perceptual spread in OKLab units. Low => high agreement.
const spread = (e) => Math.sqrt(Math.max(0, trace3(e.cov)));

// Split the spread into lightness vs chromatic components.
// Distinguishes "everyone agrees on hue, disagrees on shade" from the inverse.
const spreadAxes = (e) => ({
  L: Math.sqrt(Math.max(0, e.cov[0][0])),
  ab: Math.sqrt(Math.max(0, e.cov[1][1] + e.cov[2][2])),
});

// Shape of the cov ellipsoid (Westin-style anisotropy descriptors).
//   linearity ≈ 1  : disagreement is along a single axis (e.g. a tone gradient)
//   planarity ≈ 1  : disagreement fills a plane
//   sphericity ≈ 1 : isotropic random spread
function anisotropy(e) {
  const [l1, l2, l3] = eigvals3sym(e.cov).map((x) => Math.max(0, x));
  const sum = l1 + l2 + l3 + 1e-20;
  return {
    eigvals: [l1, l2, l3],
    linearity: (l1 - l2) / sum,
    planarity: (l2 - l3) / sum,
    sphericity: l3 / (l1 + 1e-20),
  };
}

// Perceptual chroma of the *mean* point. Tiny => muddy/grey mean.
// (A muddy mean with a huge ab-spread is the classic "crayon" signature.)
const chromaOfMean = (e) => Math.hypot(e.mean[1], e.mean[2]);

// Standard error of the mean — how well-localised the centroid is.
const meanStdError = (e) => spread(e) / Math.sqrt(Math.max(1, e.colors.length));

// Chroma-weighted circular variance of hues. High => users agree on lightness
// and saturation, but disagree on *which hue* (classic "crayon"-shaped term).
function hueDispersion(e) {
  let sx = 0,
    sy = 0,
    w = 0;
  for (const c of e.colors) {
    const [, a, b] = c.oklab;
    const ch = Math.hypot(a, b);
    if (ch < 1e-6) continue;
    sx += a;
    sy += b;
    w += ch;
  }
  return w < 1e-6 ? 0 : 1 - Math.hypot(sx, sy) / w;
}

// ----- 2-means + bimodality --------------------------------------------------

function kmeans2(points, maxIter = 30) {
  const n = points.length;
  // deterministic init: farthest pair (one pass to find a, one to find b)
  let bestD = -1,
    jStart = 0;
  for (let j = 1; j < n; j++) {
    const d = dist3sq(points[0], points[j]);
    if (d > bestD) {
      bestD = d;
      jStart = j;
    }
  }
  let c1 = points[jStart].slice();
  bestD = -1;
  let kStart = 0;
  for (let j = 0; j < n; j++) {
    const d = dist3sq(c1, points[j]);
    if (d > bestD) {
      bestD = d;
      kStart = j;
    }
  }
  let c2 = points[kStart].slice();

  const assign = new Int8Array(n);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const a = dist3sq(points[i], c1) <= dist3sq(points[i], c2) ? 0 : 1;
      if (a !== assign[i]) {
        assign[i] = a;
        changed = true;
      }
    }
    let n1 = 0,
      n2 = 0;
    const s1 = [0, 0, 0],
      s2 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (assign[i] === 0) {
        s1[0] += p[0];
        s1[1] += p[1];
        s1[2] += p[2];
        n1++;
      } else {
        s2[0] += p[0];
        s2[1] += p[1];
        s2[2] += p[2];
        n2++;
      }
    }
    if (n1) c1 = [s1[0] / n1, s1[1] / n1, s1[2] / n1];
    if (n2) c2 = [s2[0] / n2, s2[1] / n2, s2[2] / n2];
    if (!changed) break;
  }

  let sse1 = 0,
    sse2 = 0,
    n1 = 0,
    n2 = 0;
  for (let i = 0; i < n; i++) {
    if (assign[i] === 0) {
      sse1 += dist3sq(points[i], c1);
      n1++;
    } else {
      sse2 += dist3sq(points[i], c2);
      n2++;
    }
  }
  return { c1, c2, n1, n2, sse1, sse2 };
}

// Bimodality score combining three things, each individually weak:
//   reduction  : how much SSE drops going from 1 → 2 clusters
//   separation : centre gap / sum of within-cluster RMS  (Bhattacharyya-flavour)
//   balance    : min(n1,n2)/max(n1,n2)                   (both lobes have mass)
// Multiplicative — all three must be high for the term to be genuinely bimodal.
function bimodality(e, { sampleMax = 5000 } = {}) {
  if (e.colors.length < 8) return { score: 0 };
  let pts = e.colors.map((c) => c.oklab);
  if (pts.length > sampleMax) {
    const sub = new Array(sampleMax);
    for (let i = 0; i < sampleMax; i++)
      sub[i] = pts[(Math.random() * pts.length) | 0];
    pts = sub;
  }
  const N = pts.length;

  // total SSE around the unfiltered mean (cov in input is k-MAD-filtered)
  const mu = [0, 0, 0];
  for (const p of pts) {
    mu[0] += p[0];
    mu[1] += p[1];
    mu[2] += p[2];
  }
  mu[0] /= N;
  mu[1] /= N;
  mu[2] /= N;
  let totalSSE = 0;
  for (const p of pts) totalSSE += dist3sq(p, mu);

  const { c1, c2, n1, n2, sse1, sse2 } = kmeans2(pts);
  if (!n1 || !n2) return { score: 0 };

  const reduction = Math.max(0, (totalSSE - sse1 - sse2) / (totalSSE + 1e-20));
  const rms1 = Math.sqrt(sse1 / n1);
  const rms2 = Math.sqrt(sse2 / n2);
  const gap = dist3(c1, c2);
  const separation = gap / (rms1 + rms2 + 1e-20);
  const balance = Math.min(n1, n2) / Math.max(n1, n2);

  return {
    score: reduction * separation * Math.sqrt(balance),
    c1,
    c2,
    n1,
    n2,
    gap,
    separation,
    balance,
    reduction,
  };
}

// ----- distinctness from neighbours (O(N²) over means) -----------------------

// For each term, distance from its mean to the nearest other term's mean.
// Low distance => redundant / synonym-like ("crimson" near "red").
// High distance => uniquely-placed in OKLab.
function nearestNeighbours(data) {
  const out = new Map();
  const n = data.length;
  for (let i = 0; i < n; i++) {
    let bestD = Infinity,
      bestJ = -1;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = dist3sq(data[i].mean, data[j].mean);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    out.set(data[i].name, {
      neighbour: data[bestJ]?.name ?? null,
      distance: Math.sqrt(bestD),
    });
  }
  return out;
}

// ----- top-K + reporting -----------------------------------------------------

function topK(data, scoreFn, { k = 100, minColors = 30, asc = false } = {}) {
  const scored = data
    .filter((d) => d.colors.length >= minColors)
    .map((d) => ({ d, s: scoreFn(d) }))
    .filter((x) => Number.isFinite(x.s));
  scored.sort((x, y) => (asc ? x.s - y.s : y.s - x.s));
  return scored.slice(0, k);
}

// function fmt(d, s) {
//   const num = typeof s === "number" ? s.toFixed(4) : String(s);
//   return (
//     `${num.padStart(8)}  ${oklabToHex(d.mean)}  ` +
//     `${d.name.padEnd(34)}  n=${String(d.colors.length).padStart(5)}  votes=${d.votes}`
//   );
// }

function report(data, K = 20, minColors = 30) {
  const opts = { k: K, minColors };
  const sections = [
    ["Most agreed-upon (tight OKLab spread)", spread, true],
    ["Most divisive (broad OKLab spread)", spread, false],
    [
      'Hue-divisive (e.g. "crayon" — many hues, similar L)',
      hueDispersion,
      false,
    ],
    [
      "Lightness-divisive (same hue, range of shades)",
      (e) => spreadAxes(e).L,
      false,
    ],
    [
      "Linear spread (1 dominant axis of disagreement)",
      (e) => anisotropy(e).linearity,
      false,
    ],
    ["Muddy mean colour (low chroma)", chromaOfMean, true],
    ["Vivid mean colour (high chroma)", chromaOfMean, false],
    ["Most bimodal (two distinct lobes)", (e) => bimodality(e).score, false],
    ["Best-localised mean (lowest standard error)", meanStdError, true],
  ];
  for (const [label, fn, asc] of sections) {
    console.log(`\n— ${label} —`);
    for (const { d, s } of topK(data, fn, { ...opts, asc }))
      console.log(fmt(d, s));
  }
}

function fmt(d, s, extra = "") {
  const num = typeof s === "number" ? s.toFixed(4) : String(s);
  return (
    `${num.padStart(8)}  ${oklabToHex(d.mean)}  ` +
    `${d.name.padEnd(34)}  n=${String(d.colors.length).padStart(5)}  ` +
    `votes=${String(d.votes).padStart(6)}${extra ? "  " + extra : ""}`
  );
}

function section(title, rows) {
  console.log(`\n— ${title} —`);
  for (const line of rows) console.log(line);
}

export function runAll(list, { K = 25, minColors = 2 } = {}) {
  // ---- summary ------------------------------------------------------------
  const totalColors = list.reduce((s, d) => s + d.colors.length, 0);
  const totalVotes = list.reduce((s, d) => s + (d.votes || 0), 0);
  const eligible = list.filter((d) => d.colors.length >= minColors);
  console.log(
    `\n=== color-name stats =========================================`,
  );
  console.log(
    `terms:    ${list.length}  (${eligible.length} with ≥${minColors} colors)`,
  );
  console.log(`colors:   ${totalColors}`);
  console.log(`votes:    ${totalVotes}`);
  console.log(`top-K:    ${K}`);

  const tk = (fn, asc) => topK(list, fn, { k: K, minColors, asc });

  // ---- spread / agreement -------------------------------------------------
  section(
    "Most agreed-upon (tight OKLab spread)",
    tk(spread, true).map(({ d, s }) => fmt(d, s)),
  );

  section(
    "Most divisive (broad OKLab spread)",
    tk(spread, false).map(({ d, s }) => fmt(d, s)),
  );

  section(
    "Best-localised mean (low standard error)",
    tk(meanStdError, true).map(({ d, s }) => fmt(d, s)),
  );

  // ---- shape of disagreement ---------------------------------------------
  section(
    'Hue-divisive (many hues, ~constant lightness — "crayon"-shaped)',
    tk(hueDispersion, false).map(({ d, s }) => {
      const ax = spreadAxes(d);
      return fmt(d, s, `L=${ax.L.toFixed(3)} ab=${ax.ab.toFixed(3)}`);
    }),
  );

  section(
    "Lightness-divisive (same hue, range of shades)",
    tk((e) => spreadAxes(e).L, false).map(({ d, s }) => {
      const ax = spreadAxes(d);
      return fmt(d, s, `ab=${ax.ab.toFixed(3)}`);
    }),
  );

  section(
    "Linear-spread (disagreement along ONE axis — tone continuum)",
    tk((e) => anisotropy(e).linearity, false).map(({ d, s }) => fmt(d, s)),
  );

  // ---- chroma -------------------------------------------------------------
  section(
    "Muddy mean colour (low chroma — possibly hue-divisive)",
    tk(chromaOfMean, true).map(({ d, s }) => fmt(d, s)),
  );

  section(
    "Vivid mean colour (high chroma)",
    tk(chromaOfMean, false).map(({ d, s }) => fmt(d, s)),
  );

  section(
    "Iconic (vivid AND well-agreed): chroma / spread",
    tk((e) => chromaOfMean(e) / (spread(e) + 1e-6), false).map(({ d, s }) =>
      fmt(d, s),
    ),
  );

  // ---- bimodality (cache results so we can print sub-details) -------------
  const bi = new Map();
  for (const d of list) {
    if (d.colors.length >= minColors) bi.set(d, bimodality(d));
  }
  const biSorted = [...bi.entries()]
    .map(([d, b]) => ({ d, b }))
    .sort((a, b) => b.b.score - a.b.score)
    .slice(0, K);

  section(
    "Most bimodal (two distinct lobes)",
    biSorted.map(({ d, b }) => {
      const c1 = oklabToHex(b.c1),
        c2 = oklabToHex(b.c2);
      return fmt(
        d,
        b.score,
        `gap=${b.gap.toFixed(3)} bal=${b.balance.toFixed(2)} lobes=${c1}/${c2} (${b.n1}/${b.n2})`,
      );
    }),
  );

  // ---- neighbour distances (O(N²) over means; ~50M ops for 10K terms) -----
  const nn = nearestNeighbours(eligible);
  const withNN = eligible
    .map((d) => ({ d, nn: nn.get(d.name) }))
    .filter((x) => x.nn && Number.isFinite(x.nn.distance));

  section(
    "Most isolated terms (no near synonym in OKLab)",
    [...withNN]
      .sort((a, b) => b.nn.distance - a.nn.distance)
      .slice(0, K)
      .map(({ d, nn }) => fmt(d, nn.distance, `→ ${nn.neighbour}`)),
  );

  section(
    "Most redundant terms (very close to another name)",
    [...withNN]
      .sort((a, b) => a.nn.distance - b.nn.distance)
      .slice(0, K)
      .map(({ d, nn }) => fmt(d, nn.distance, `→ ${nn.neighbour}`)),
  );

  // ---- engagement metrics -------------------------------------------------
  section(
    "Highest vote conviction (votes per unique user)",
    tk((e) => e.votes / Math.max(1, e.userVotes), false).map(({ d, s }) =>
      fmt(d, s, `users=${d.userVotes}`),
    ),
  );

  section(
    "Most popular (by unique users)",
    tk((e) => e.userVotes, false).map(({ d, s }) => fmt(d, s)),
  );

  console.log(
    "\n=== done =====================================================\n",
  );
}

let colors = convert(loadDataFromJSON(rows), {
  minUsers: 20,
  maxCount: 15000,
  curated: false,
  sort: "users",
});

runAll(colors);
