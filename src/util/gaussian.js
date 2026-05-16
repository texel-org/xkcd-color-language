import * as Color from "@texel/color";
import { getNameMap } from "./json.js";
import { isFlagged } from "../survey/constants-curate.js";

export const DEFAULT_AB_FACTOR = 2.0;

const K_MAD_SCALE = 1.4826;
const FILTER_EPSILON = 1e-6;

function applyMask(items, mask) {
  return items.filter((_, i) => mask[i]);
}

export function fitGaussian(points) {
  const n = points.length;
  if (!n) throw new Error("fitGaussian() requires at least one point");

  const d = points[0].length;
  const mean = Array(d).fill(0);
  const cov = Array.from({ length: d }, () => Array(d).fill(0));

  for (const p of points) {
    for (let i = 0; i < d; i++) mean[i] += p[i];
  }

  for (let i = 0; i < d; i++) mean[i] /= n;

  if (n < 2) return { mean, cov };

  for (const p of points) {
    for (let i = 0; i < d; i++) {
      const di = p[i] - mean[i];
      for (let j = i; j < d; j++) {
        cov[i][j] += di * (p[j] - mean[j]);
      }
    }
  }

  const scale = 1 / (n - 1);
  for (let i = 0; i < d; i++) {
    cov[i][i] *= scale;
    for (let j = i + 1; j < d; j++) {
      cov[j][i] = cov[i][j] *= scale;
    }
  }

  return { mean, cov };
}

export function buildColorCache(
  data,
  {
    minUsers = 1,
    maxUsers = Infinity,
    maxCount = 5000,
    curated = false,
    sort = "users",
  } = {},
) {
  const nameMap = getNameMap(data);
  const sorted = Array.from(nameMap.entries())
    .map((item) => {
      const records = item[1];
      const votes = records.length;
      const userVotes = new Set(records.map((i) => data[i].user)).size;
      const count = sort == "users" ? userVotes : votes;
      return { item, count, votes, userVotes };
    })
    .sort((a, b) => b.count - a.count)
    .filter((d) => {
      const inCount = d.userVotes >= minUsers && d.userVotes <= maxUsers;
      if (!inCount) return false;
      return curated ? !isFlagged(d.item[0]) : true;
    })
    .slice(0, maxCount)
    .map((n) => n.item);

  return sorted.map(([name, records]) => {
    const colors = records.map((idx) => {
      const record = data[idx];
      const srgb = Color.hexToRGB(record.hex);
      return {
        srgb,
        hex: record.hex,
        oklab: Color.convert(srgb, Color.sRGB, Color.OKLab),
        record,
      };
    });
    return { name, records, colors };
  });
}

export function convertWithCache(data, cache, opts = {}) {
  const {
    filter = "mad",
    minFilterCount = 5,
    abFactor = DEFAULT_AB_FACTOR,
    gamutMapping = Color.MapToCuspL,
    maxDeltaE = 0.2,
  } = opts;

  return cache.map(({ name, records, colors }) => {
    let filteredColors = colors;
    if (colors.length > minFilterCount) {
      const oklabs = colors.map((c) => c.oklab);
      let mask = null;
      if (filter === "mad") {
        mask = filterMaskMAD(oklabs, undefined, abFactor);
      } else if (filter === "euclidean") {
        mask = filterMaskEuclidean(oklabs, maxDeltaE, abFactor);
      } else if (filter !== "none" && filter) {
        throw new Error("invalid filter: " + filter);
      }
      if (mask) {
        const filtered = applyMask(colors, mask);
        if (filtered.length > 0) filteredColors = filtered;
      }
    }

    const { mean, cov } = fitGaussian(filteredColors.map((c) => c.oklab));
    const srgb = Color.gamutMapOKLCH(
      Color.convert(mean, Color.OKLab, Color.OKLCH),
      Color.sRGBGamut,
      Color.sRGB,
      undefined,
      gamutMapping,
    );
    const hex = Color.RGBToHex(srgb);

    const userVotes = new Set(records.map((i) => data[i].user)).size;

    return {
      name,
      votes: records.length,
      userVotes,
      count: filteredColors.length,
      colors,
      filteredColors,
      filteredRecords: filteredColors.map((c) => c.record),
      flagged: isFlagged(name),
      srgb,
      hex,
      mean,
      cov,
    };
  });
}

export function convert(data, opts = {}) {
  return convertWithCache(data, buildColorCache(data, opts), opts);
}

export function filterMaskMAD(oklabs, k = 2.5, abFactor = DEFAULT_AB_FACTOR) {
  const center = robustCentroid(oklabs);
  const dists = oklabs.map((c) => deltaEOK2(c, center, abFactor));
  const med = medianOf(dists);
  const mad =
    medianOf(dists.map((d) => Math.abs(d - med))) * K_MAD_SCALE ||
    FILTER_EPSILON;
  const threshold = med + k * mad;
  return dists.map((d) => d <= threshold);
}

export function filterMaskEuclidean(
  oklabs,
  maxDeltaE = 0.2,
  abFactor = DEFAULT_AB_FACTOR,
) {
  const centroid = computeCentroid(oklabs);
  const maxDeltaESqr = maxDeltaE ** 2;
  return oklabs.map(
    (c) => deltaEOK2Squared(c, centroid, abFactor) <= maxDeltaESqr,
  );
}

export function deltaEOK2Squared(a, b, abFactor = DEFAULT_AB_FACTOR) {
  const dL = a[0] - b[0];
  const da = (a[1] - b[1]) * abFactor;
  const db = (a[2] - b[2]) * abFactor;
  return dL * dL + da * da + db * db;
}

export function deltaEOK2(a, b, abFactor = 2) {
  return Math.sqrt(deltaEOK2Squared(a, b, abFactor));
}

export function medianOf(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function robustCentroid(vectors) {
  const dim = vectors[0].length;
  return Array.from({ length: dim }, (_, i) =>
    medianOf(vectors.map((v) => v[i])),
  );
}

export function computeCentroid(vectors) {
  const dim = vectors[0].length;
  const sum = Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  return sum.map((s) => s / vectors.length);
}

export function filterOutliersMAD(
  oklabs,
  k = 2.5,
  abFactor = DEFAULT_AB_FACTOR,
) {
  return applyMask(oklabs, filterMaskMAD(oklabs, k, abFactor));
}

export function filterOutliersEuclidean(
  oklabs,
  maxDeltaE = 0.2,
  abFactor = DEFAULT_AB_FACTOR,
) {
  return applyMask(oklabs, filterMaskEuclidean(oklabs, maxDeltaE, abFactor));
}

function euclideanDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

export function geometricMedian(
  vectors,
  { maxIter = 100, tol = 1e-7, epsilon = 1e-12 } = {},
) {
  const n = vectors.length;
  if (!n) throw new Error("geometricMedian() requires at least one point");
  const dim = vectors[0].length;
  if (n === 1) return [...vectors[0]];
  let y = computeCentroid(vectors);
  for (let iter = 0; iter < maxIter; iter++) {
    let weightSum = 0;
    const next = Array(dim).fill(0);
    for (const v of vectors) {
      const d = euclideanDistance(v, y) + epsilon;
      const w = 1 / d;
      weightSum += w;
      for (let i = 0; i < dim; i++) next[i] += v[i] * w;
    }
    for (let i = 0; i < dim; i++) next[i] /= weightSum;
    let movement = 0;
    for (let i = 0; i < dim; i++) {
      const d = next[i] - y[i];
      movement += d * d;
    }
    y = next;
    if (Math.sqrt(movement) < tol) break;
  }
  return y;
}

export function closestPointIndex(vectors, target) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < vectors.length; i++) {
    const d = euclideanDistance(vectors[i], target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function nextGaussianBoxMuller(mean = 0, std = 1, random = Math.random) {
  const u1 = Math.max(random(), 1e-12); // avoid log(0)
  const u2 = random();
  const r = Math.sqrt(-2.0 * Math.log(u1));
  const theta = 2.0 * Math.PI * u2;
  const z = r * Math.cos(theta); // one of the two samples
  return mean + std * z;
}
