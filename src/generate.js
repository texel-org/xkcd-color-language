import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getNameMap, getUserMap, loadDataFromJSON } from "./util/json.js";
import { convert, deltaEOK2 } from "./util/gaussian.js";

const src = await readFile("data/xkcd/answers.compact.json", "utf8");
const json = JSON.parse(src);

const data = loadDataFromJSON(json);
console.log("Total Records:", data.length);

// const nameMap = getNameMap(data);
// const userMap = getUserMap(data);
// const sorted = Array.from(nameMap.entries()).sort(
//   (a, b) => b[1].length - a[1].length,
// );

// const list = [];
// for (let s of sorted.slice(0, 10000)) {
//   const name = s[0];

//   const userIDs = s[1].map((i) => data[i].user);
//   const colorCount = s[1].length;
//   const uniqueUserCount = new Set(userIDs).size;
//   const ratio = uniqueUserCount / colorCount;
//   if (uniqueUserCount <= 1) {
//     console.log(
//       `${name} (${uniqueUserCount} users of ${colorCount} colors) (${Math.floor(
//         100 * ratio,
//       )}%)`,
//     );
//     list.push(name);
//   }

//   // if (uniqueUserCount <= 3 || ratio <= 0.25) {
//   // console.log(
//   //   `${name} (${uniqueUserCount} users of ${colorCount} colors) (${Math.floor(
//   //     100 * ratio,
//   //   )}%)`,
//   // );
//   // }
// }

// console.log(JSON.stringify(list, null, 2));

const colors = convert(data, {
  debug: true,
  filter: "mad",
  minUsers: 5,
  curated: true,
  // maxUsers: 6,
  maxCount: 10000,
});
const maxLenDigits = String(colors.length).length;
console.log(colors.length);
for (let i = 0; i < colors.length; i++) {
  const {
    name, // label
    votes, // pre filter
    userVotes, // unique users (pre filter)
    count, // post filter
    mean, // in OKLab [ L, a, b ]
    cov, // covariance matrix
    filteredColors, // list of { oklab } colors
  } = colors[i];
  console.log(
    `${String(i).padStart(maxLenDigits, "0")}: ${name} (votes:${votes} userVotes:${userVotes})`,
  );

  // list of oklabs associated with this label in case its useful
  // console.log(filteredColors[0].oklab);

  // example delta computation between two OKLabs
  // const threshold = 0.3; // a good metric for "far away"
  // const deltaE = deltaEOK2([L0,a0,b0], [L1,a1,b1])
}

// const undecided = findUndecidedColors(colors, {
//   minCount: 12,
//   k: 6,
//   farDelta: 0.3,
//   minScore: 0.42,
//   limit: 100,
// });

// for (const d of undecided) {
//   console.log(
//     `${d.name} (${d.votes}) score=${d.score.toFixed(3)} ` +
//       `mean=${d.avgMeanDistance.toFixed(3)} ` +
//       `local=${d.avgNearestDistance.toFixed(3)} ` +
//       `far=${d.farRatio.toFixed(2)} ` +
//       `isolated=${d.isolatedRatio.toFixed(2)}`,
//   );
// }

function findUndecidedColors(colors, opts = {}) {
  const {
    // Ignore labels with too few samples to judge reliably.
    minCount = 5,
    // Ignore labels with many colors as they are likely OK
    maxCount = 1000,

    // How many nearest neighbors to inspect per sample.
    // Smaller = detects local spike/island structure.
    k = 6,

    // DeltaE in OKLab-space that counts as “far”.
    // You mentioned ~0.3 as a good far-away metric.
    farDelta = 0.3,

    // Labels above this score are returned.
    minScore = 0.42,

    // Optional hard cap on results.
    limit = Infinity,
  } = opts;

  const scored = [];

  for (const color of colors) {
    const { name, votes, count, mean, filteredColors } = color;

    if (
      !filteredColors ||
      filteredColors.length < minCount ||
      filteredColors.length > maxCount
    )
      continue;

    const points = filteredColors.map((c) => c.oklab).filter(Boolean);

    if (points.length < minCount) continue;

    let meanDistanceSum = 0;
    let farFromMean = 0;
    let nearestDistanceSum = 0;
    let isolated = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];

      const dMean = deltaEOK2(p, mean);
      meanDistanceSum += dMean;

      if (dMean >= farDelta) {
        farFromMean++;
      }

      const distances = [];

      for (let j = 0; j < points.length; j++) {
        if (i === j) continue;
        distances.push(deltaEOK2(p, points[j]));
      }

      distances.sort((a, b) => a - b);

      const kk = Math.min(k, distances.length);
      let localSum = 0;

      for (let n = 0; n < kk; n++) {
        localSum += distances[n];
      }

      const localAvg = localSum / kk;
      nearestDistanceSum += localAvg;

      if (localAvg >= farDelta * 0.6) {
        isolated++;
      }
    }

    const avgMeanDistance = meanDistanceSum / points.length;
    const avgNearestDistance = nearestDistanceSum / points.length;
    const farRatio = farFromMean / points.length;
    const isolatedRatio = isolated / points.length;

    // Measures whether the cloud is diffuse, multi-modal, or incoherent.
    // Good labels like "dark blue" should have low local spread and low farRatio.
    // Troll-ish labels like "marzipan", "messy", "beautiful" should score higher.
    const undecidedScore =
      avgMeanDistance * 1.15 +
      avgNearestDistance * 1.75 +
      farRatio * 0.45 +
      isolatedRatio * 0.65;

    scored.push({
      name,
      votes,
      count,
      score: undecidedScore,
      avgMeanDistance,
      avgNearestDistance,
      farRatio,
      isolatedRatio,
      color,
    });
  }

  return scored
    .filter((d) => d.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
