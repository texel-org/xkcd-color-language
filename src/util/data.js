import * as Color from "@texel/color";
import { degToRad, radToDeg } from "canvas-sketch-util/math.js";
import { getNameMap } from "./json.js";
import { contrastRatio } from "canvas-sketch-util/color.js";

const DEFAULT_AB_FACTOR = 2;

export function findForeground(color) {
  return contrastRatio(color, "white") > contrastRatio(color, "black")
    ? "#e2e3db"
    : "#252224";
}

export function prepareData(data, opts = {}) {
  const { minVotes = 20, maxVotes = Infinity, outlierThreshold = 0.2 } = opts;

  const nameMap = getNameMap(data);

  const sorted = Array.from(nameMap.entries());
  sorted.sort((a, b) => {
    return b[1].length - a[1].length;
  });

  const topKItems = sorted.filter(
    (f) => f[1].length >= minVotes && f[1].length < maxVotes,
  );

  const totalKCount = topKItems.reduce((sum, a) => sum + a[1].length, 0);

  return topKItems
    .map((c) => {
      const name = c[0];
      let colors = c[1].map((idx) => {
        const c = data[idx];
        const srgb = Color.hexToRGB(c.hex);
        const oklab = Color.convert(srgb, Color.sRGB, Color.OKLab);
        const oklch = Color.convert(oklab, Color.OKLab, Color.OKLCH);
        return { hex: c.hex, srgb, oklab, oklch };
      });

      const votes = c[1].length;
      const weight = votes / totalKCount;

      if (outlierThreshold > 0) {
        colors = filterOutliers(colors, outlierThreshold);
      }
      if (colors.length <= 0) return null;
      if (colors.length < minVotes) return null;

      const [L, a, b, C] = computeCentroid(
        colors.map((c) => {
          const oklab = c.oklab;
          const oklch = c.oklch;
          return [oklab[0], oklab[1], oklab[2], oklch[1]];
        }),
      );

      const anglesRad = colors.map((c) => degToRad(c.oklch[2]));
      const H = radToDeg(computeCircularMean(anglesRad));
      const oklabRaw = [L, a, b]; // may be out of srgb gamut
      // const oklabRaw = Color.convert([L, C, H], Color.OKLCH, Color.OKLab);
      const colorInfo = toColorData(oklabRaw, Color.sRGBGamut);

      return {
        ...colorInfo,
        H, // mean, which may not match the H if we were to convert to OKLCH
        name,
        colors,
        weight,
        votes,
      };
    })
    .filter(Boolean);
}

export function computeCentroid(vectors) {
  if (!vectors.length) throw new Error("computeCentroid: empty array");
  const n = vectors.length;
  const dim = vectors[0].length;
  const sum = Array(dim).fill(0);

  for (const p of vectors) {
    if (p.length !== dim)
      throw new Error("computeCentroid: inconsistent dimensions");
    for (let i = 0; i < dim; i++) {
      sum[i] += p[i];
    }
  }

  return sum.map((v) => v / n);
}

export function wrapAngleRad(theta) {
  const TAU = 2 * Math.PI;
  theta = theta % TAU;
  return theta < 0 ? theta + TAU : theta;
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

export function filterOutliers(colors, maxDeltaE = 0.15, centroid) {
  const maxDeltaESqr = maxDeltaE ** 2;
  if (!centroid) centroid = computeCentroid(colors.map((c) => c.oklab));
  return colors.filter((color) => {
    return deltaEOK2Squared(color.oklab, centroid) <= maxDeltaESqr;
  });
}

export function computeCircularMean(arr) {
  let sumSin = 0;
  let sumCos = 0;

  for (let a of arr) {
    sumSin += Math.sin(a);
    sumCos += Math.cos(a);
  }

  let mean = Math.atan2(sumSin / arr.length, sumCos / arr.length);

  // normalize to [0, 2π)
  return (mean + 2 * Math.PI) % (2 * Math.PI);
}

export function toColorData(oklabRaw, gamut = Color.sRGBGamut) {
  const oklchRaw = Color.convert(oklabRaw, Color.OKLab, Color.OKLCH);
  const rgb = Color.gamutMapOKLCH(
    oklchRaw,
    gamut,
    gamut.space,
    undefined,
    Color.MapToL,
  );
  const oklab = Color.convert(rgb, gamut.space, Color.OKLab);
  const oklch = Color.convert(oklab, Color.OKLab, Color.OKLCH);
  const hex = Color.RGBToHex(rgb);
  return { hex, rgb, oklab, oklch };
}
