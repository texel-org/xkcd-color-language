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
// import SpellChecker from "fast-spell";
import * as Color from "@texel/color";

const src = await readFile("data/xkcd/answers.compact.json", "utf8");
const rows = JSON.parse(src);

// Fraction of votes that are "repeats" by users who already voted.
// 0 = everyone voted exactly once; → 1 = a small clique dominates.
const repeatVoteFraction = (e) => (e.votes > 0 ? 1 - e.userVotes / e.votes : 0);

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

// Long-tail score: ratio of the 90th-percentile distance-from-mean to the
// median distance-from-mean. High = a tight core with a minority of points
// reaching far away. Distinct from bimodality (which is balanced) and from
// broad spread (which is roughly symmetric).
//   Tight cluster:    p90/p50 ≈ 1.5
//   Symmetric spread: p90/p50 ≈ 2
//   Long tail:        p90/p50 ≈ 4+
function longTail(e) {
  if (e.colors.length < 10) return 0;
  const dists = e.colors.map((c) => dist3(c.oklab, e.mean));
  dists.sort((a, b) => a - b);
  const n = dists.length;
  const median = dists[n >> 1];
  const p90 = dists[Math.min(n - 1, Math.floor(n * 0.9))];
  return median < 1e-9 ? 0 : p90 / median;
}

// Centroid of the tail-end (points beyond the 75th-percentile distance from
// the mean). Useful for showing *what* the minority interpretation looks like.
function tailCentroid(e) {
  if (e.colors.length < 10) return null;
  const wd = e.colors.map((c) => ({ p: c.oklab, d: dist3(c.oklab, e.mean) }));
  wd.sort((a, b) => a.d - b.d);
  const tail = wd.slice(Math.floor(wd.length * 0.75));
  if (!tail.length) return null;
  const s = [0, 0, 0];
  for (const { p } of tail) {
    s[0] += p[0];
    s[1] += p[1];
    s[2] += p[2];
  }
  return [s[0] / tail.length, s[1] / tail.length, s[2] / tail.length];
}

function oklabToSRGB(oklab) {
  return Color.gamutMapOKLCH(
    Color.convert(oklab, Color.OKLab, Color.OKLCH),
    Color.sRGBGamut,
    Color.sRGB,
    undefined,
    Color.MapToL,
  );
}

function oklabToRawLinearSRGB(oklab) {
  return Color.convert(oklab, Color.OKLab, Color.sRGBLinear);
}

// Signed distance from mean to the sRGB cube boundary (in linear RGB).
//   > 0 : inside, distance to nearest face
//   = 0 : on the boundary
//   < 0 : outside the gamut (will clip on display)
// Sort ascending — smaller = more "extreme" colour.
const gamutEdgeSignedDistance = (e) => {
  const [r, g, b] = oklabToRawLinearSRGB(e.mean);
  return Math.min(r, g, b, 1 - r, 1 - g, 1 - b);
};

// Volume of the cov ellipsoid (sqrt of the generalized variance).
// Catches broadly-spread terms even when their RMS is moderate, because
// anisotropic shapes can have high trace but small det, and vice versa.
const ellipsoidVolume = (e) => Math.sqrt(Math.max(0, det3(e.cov)));

// OKLab -> sRGB hex (for console-printing). Clamps out-of-gamut.
function oklabToHex(oklab) {
  return Color.RGBToHex(oklabToSRGB(oklab));
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

// Spread of chroma values within a term. High = users agree on hue/lightness
// roughly, but disagree on how *saturated* the color should be (e.g. some
// pick a muted version, some pick a vivid one).
function chromaDispersion(e) {
  let s = 0,
    s2 = 0,
    n = 0;
  for (const c of e.colors) {
    const ch = Math.hypot(c.oklab[1], c.oklab[2]);
    s += ch;
    s2 += ch * ch;
    n++;
  }
  if (n < 2) return 0;
  const mean = s / n;
  return Math.sqrt(Math.max(0, s2 / n - mean * mean));
}

// Like hueDispersion, but scaled by the term's typical chromaticity.
// Suppresses muted/gray crayons; surfaces vivid ones with many hues.
function vividHueDispersion(e) {
  let sx = 0,
    sy = 0,
    w = 0,
    sumCh = 0,
    n = 0;
  for (const c of e.colors) {
    const [, a, b] = c.oklab;
    const ch = Math.hypot(a, b);
    n++;
    sumCh += ch;
    if (ch < 1e-6) continue;
    sx += a;
    sy += b;
    w += ch;
  }
  if (w < 1e-6 || n === 0) return 0;
  const dispersion = 1 - Math.hypot(sx, sy) / w;
  const meanChroma = sumCh / n;
  return dispersion * meanChroma;
}

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

// effIndependentVoters = userVotes² / votes
// If everyone votes exactly once: equals userVotes
// If one user voted N times: equals 1/N
// Rewards both popularity AND independence. High = broad consensus across
// many people, not a few users hammering the button.
const effIndependentVoters = (e) =>
  e.votes > 0 ? (e.userVotes * e.userVotes) / e.votes : 0;

function makeHistogram(list, { bins, minColors, minChroma = 0, kind, weight }) {
  // kind: "hue" | "L"
  // weight: "userVotes" | "votes" | "terms" | fn(e) -> number
  const counts = new Array(bins).fill(0);
  const w =
    typeof weight === "function"
      ? weight
      : weight === "userVotes"
        ? (e) => e.userVotes
        : weight === "votes"
          ? (e) => e.votes
          : (e) => 1;
  for (const e of list) {
    if (e.colors.length < minColors) continue;
    let bin;
    if (kind === "hue") {
      const [, a, b] = e.mean;
      if (Math.hypot(a, b) < minChroma) continue; // skip near-greys
      let h = Math.atan2(b, a);
      if (h < 0) h += 2 * Math.PI;
      bin = Math.min(bins - 1, Math.floor((h / (2 * Math.PI)) * bins));
    } else {
      // "L"
      bin = Math.min(bins - 1, Math.max(0, Math.floor(e.mean[0] * bins)));
    }
    counts[bin] += w(e);
  }
  return counts;
}

function printBars(label, counts, labelFor) {
  console.log(`\n— ${label} —`);
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  const ranked = counts.map((c, i) => ({ c, i })).sort((a, b) => b.c - a.c);
  const topI = ranked[0]?.i,
    botI = ranked[ranked.length - 1]?.i;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i];
    const bar = Math.round((n / max) * 40);
    const pct = total ? ((100 * n) / total).toFixed(1).padStart(5) : "  0.0";
    const tag = i === topI ? " ← most" : i === botI ? " ← least" : "";
    console.log(
      `  ${labelFor(i).padEnd(16)}  ${"█".repeat(bar).padEnd(40)}  ${String(n).padStart(8)}  ${pct}%${tag}`,
    );
  }
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

// IMDb-style shrinkage to the median of the raw scores:
//   shrunk = (n*raw + m*median) / (n + m)
// With m=10: n=5 keeps 33% of raw + 67% of median; n=50 ≈ 83%; n=500 ≈ 98%.
// Works for every metric and both sort directions — extremes regress toward
// typical, so low-n entries can't dominate either end of the ranking.
function topK(
  data,
  scoreFn,
  {
    k = 100,
    minColors = 30,
    asc = false,
    weighted = true,
    priorWeight = 10,
  } = {},
) {
  const scored = data
    .filter((d) => d.colors.length >= minColors)
    .map((d) => ({ d, raw: scoreFn(d), n: d.colors.length }))
    .filter((x) => Number.isFinite(x.raw));

  if (weighted && scored.length) {
    const sorted = scored.map((x) => x.raw).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    for (const x of scored) {
      x.s = (x.n * x.raw + priorWeight * median) / (x.n + priorWeight);
    }
  } else {
    for (const x of scored) x.s = x.raw;
  }

  scored.sort((x, y) => (asc ? x.s - y.s : y.s - x.s));
  return scored.slice(0, k);
}

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

export function runAll(
  list,
  { K = 50, minColors = 2, weighted = false, priorWeight = 10 } = {},
) {
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
  console.log(
    `weighted: ${weighted ? `yes (priorWeight=${priorWeight})` : "no"}`,
  );

  const tk = (fn, asc) =>
    topK(list, fn, { k: K, minColors, asc, weighted, priorWeight });

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

  section(
    "Long-tail (mostly agreed, but a minority of dissenters)",
    tk(longTail, false).map(({ d, s }) => {
      const tc = tailCentroid(d);
      return fmt(
        d,
        s,
        `core=${oklabToHex(d.mean)} tail≈${tc ? oklabToHex(tc) : "—"}`,
      );
    }),
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
    "Hue-divisive AND vivid (saturated crayon-shaped — many bright hues)",
    tk(vividHueDispersion, false).map(({ d, s }) => {
      const ax = spreadAxes(d);
      return fmt(
        d,
        s,
        `hueDisp=${hueDispersion(d).toFixed(3)} meanC=${(s / Math.max(1e-9, hueDispersion(d))).toFixed(3)}`,
      );
    }),
  );

  section(
    "Chroma-divisive (users disagree on saturation — muted vs vivid same-hue)",
    tk(chromaDispersion, false).map(({ d, s }) => {
      const hd = hueDispersion(d);
      return fmt(d, s, `hueDisp=${hd.toFixed(3)}`);
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
  const bi = [];
  for (const d of list) {
    if (d.colors.length >= minColors) {
      bi.push({ d, b: bimodality(d), n: d.colors.length });
    }
  }

  if (weighted && bi.length) {
    const sorted = bi.map((x) => x.b.score).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    for (const x of bi) {
      x.s = (x.n * x.b.score + priorWeight * median) / (x.n + priorWeight);
    }
  } else {
    for (const x of bi) x.s = x.b.score;
  }

  const biSorted = bi.sort((a, b) => b.s - a.s).slice(0, K);

  section(
    "Most bimodal (two distinct lobes)",
    biSorted.map(({ d, b, s }) => {
      const c1 = oklabToHex(b.c1),
        c2 = oklabToHex(b.c2);
      return fmt(
        d,
        s,
        `gap=${b.gap.toFixed(3)} bal=${b.balance.toFixed(2)} lobes=${c1}/${c2} (${b.n1}/${b.n2})`,
      );
    }),
  );

  // ---- neighbour distances (O(N²) over means; ~50M ops for 10K terms) -----
  // (Not shrinkage-weighted: this asks "is term X's mean close to term Y's
  // mean?", which doesn't depend on each term's sample size.)
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
  // (Not shrinkage-weighted: votes and userVotes are direct counts, not
  // noisy estimates of an underlying parameter.)
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

  section(
    "Broad consensus (many independent voters, few repeats)",
    tk(effIndependentVoters, false).map(({ d, s }) =>
      fmt(
        d,
        s,
        `users=${d.userVotes} votes=${d.votes} v/u=${(d.votes / Math.max(1, d.userVotes)).toFixed(2)}`,
      ),
    ),
  );

  section(
    "Repeat-heavy (a clique hammering the same name)",
    tk(repeatVoteFraction, false).map(({ d, s }) =>
      fmt(d, s, `users=${d.userVotes} votes=${d.votes}`),
    ),
  );

  console.log("\n===== more stats ==== ");

  // ---- L and C extremes (with agreement) ----------------------------------
  section(
    "Lightest (high L with agreement): L − spread",
    tk((e) => e.mean[0] - spread(e), false).map(({ d, s }) =>
      fmt(d, s, `L=${d.mean[0].toFixed(3)} spread=${spread(d).toFixed(3)}`),
    ),
  );
  section(
    "Darkest (low L with agreement): L + spread",
    tk((e) => e.mean[0] + spread(e), true).map(({ d, s }) =>
      fmt(d, s, `L=${d.mean[0].toFixed(3)} spread=${spread(d).toFixed(3)}`),
    ),
  );
  section(
    "Most chromatic (high chroma with agreement): C − spread",
    tk((e) => chromaOfMean(e) - spread(e), false).map(({ d, s }) =>
      fmt(
        d,
        s,
        `C=${chromaOfMean(d).toFixed(3)} spread=${spread(d).toFixed(3)}`,
      ),
    ),
  );
  section(
    "Most achromatic (low chroma with agreement): C + spread",
    tk((e) => chromaOfMean(e) + spread(e), true).map(({ d, s }) =>
      fmt(
        d,
        s,
        `C=${chromaOfMean(d).toFixed(3)} spread=${spread(d).toFixed(3)}`,
      ),
    ),
  );

  // ---- Gamut edge --------------------------------------------------------
  section(
    "Gamut-edge terms (mean near or outside the sRGB cube)",
    tk(gamutEdgeSignedDistance, true).map(({ d, s }) => {
      const [r, g, b] = oklabToRawLinearSRGB(d.mean);
      const inside = r >= 0 && g >= 0 && b >= 0 && r <= 1 && g <= 1 && b <= 1;
      return fmt(
        d,
        s,
        `${inside ? "inside" : " OUT  "} lin=(${r.toFixed(2)},${g.toFixed(2)},${b.toFixed(2)})`,
      );
    }),
  );

  // ---- Ellipsoid volume --------------------------------------------------
  section(
    "Largest cov ellipsoid volume (broad 3D coverage)",
    tk(ellipsoidVolume, false).map(({ d, s }) => {
      const ax = spreadAxes(d);
      return fmt(d, s, `L=${ax.L.toFixed(3)} ab=${ax.ab.toFixed(3)}`);
    }),
  );
  section(
    "Smallest cov ellipsoid volume (tightest 3D agreement)",
    tk(ellipsoidVolume, true).map(({ d, s }) => fmt(d, s)),
  );

  console.log("==== histo ====");

  // ---- whole-dataset histograms -------------------------------------------
  const HUE_BINS = 24;
  const L_BINS = 20;

  const hueLabel = (i) => {
    const deg = Math.round(((i + 0.5) / HUE_BINS) * 360);
    const h = ((i + 0.5) / HUE_BINS) * 2 * Math.PI;
    return `${String(deg).padStart(3)}° ${oklabToHex([0.65, 0.15 * Math.cos(h), 0.15 * Math.sin(h)])}`;
  };
  const lLabel = (i) => {
    const Lmid = (i + 0.5) / L_BINS;
    return `L=${Lmid.toFixed(2)} ${oklabToHex([Lmid, 0, 0])}`;
  };

  printBars(
    `Hue histogram — weighted by userVotes (${HUE_BINS} bins of 15°)`,
    makeHistogram(list, {
      bins: HUE_BINS,
      minColors,
      kind: "hue",
      minChroma: 0.02,
      weight: "userVotes",
    }),
    hueLabel,
  );
  printBars(
    `Hue histogram — one count per term (where in OKLab the *names* live)`,
    makeHistogram(list, {
      bins: HUE_BINS,
      minColors,
      kind: "hue",
      minChroma: 0.02,
      weight: "terms",
    }),
    hueLabel,
  );
  printBars(
    `Lightness histogram — weighted by userVotes (${L_BINS} bins)`,
    makeHistogram(list, {
      bins: L_BINS,
      minColors,
      kind: "L",
      weight: "userVotes",
    }),
    lLabel,
  );
  printBars(
    `Lightness histogram — one count per term`,
    makeHistogram(list, {
      bins: L_BINS,
      minColors,
      kind: "L",
      weight: "terms",
    }),
    lLabel,
  );

  console.log(
    "\n=== done =====================================================\n",
  );
}

let colors = convert(loadDataFromJSON(rows), {
  minUsers: 5,
  maxCount: 15000,
  curated: false,
  sort: "users",
});

runAll(colors);
