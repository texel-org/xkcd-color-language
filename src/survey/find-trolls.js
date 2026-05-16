import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as Color from "@texel/color";
import {
  getNameMap,
  getUserMap,
  loadData,
  loadDataFromJSON,
} from "../util/json.js";
import { deltaEOK2, prepareData } from "../util/data.js";

const src = await readFile("data/xkcd/answers.compact.json", "utf8");
const json = JSON.parse(src);

const data = loadDataFromJSON(json);
console.log("Count:", data.length);

console.log("Computing means...");
const colors = prepareData(data, {
  minVotes: 5,
  maxCount: Infinity,
  outlierThreshold: 0.2,
});

console.log("Color Vocab Count:", colors.length);

const bestTokenVocab = new Set();
for (let c of colors) {
  const tokens = c.name.split(" ");
  tokens.forEach((t) => bestTokenVocab.add(t));
}

const byUsers = getUserMap(data);
const nameMap = getNameMap(data);

findRoutine2();

/// -------------

/// --------------

function findRoutine2() {
  console.log("Getting named colors...");
  const wrongThreshold = 0.3;
  const usersByScore = [];
  for (let [userId, records] of byUsers.entries()) {
    let delta = 0;
    let missCount = 0;
    let wrongRate = 0;
    let colorCount = 0;
    let outOfVocabTokens = 0;
    let tokenCount = 0;
    // console.log("Getting indices...", records);
    for (let i of records) {
      const { name, hex } = data[i];
      // find the 'true' mean of the label according to whole population
      const center = colors.find((c) => c.name == name);
      if (center) {
        // what color the user was presented with
        const oklab = Color.convert(
          Color.hexToRGB(hex),
          Color.sRGB,
          Color.OKLab,
        );
        // how does it compare to the expected mean?
        const err = deltaEOK2(center.oklab, oklab);
        delta += err * err;
        if (err > wrongThreshold) {
          wrongRate++;
        }
        colorCount++;
      } else {
        // user assigned a label that wasn't very popular
        missCount++;
        // we will just say their delta error is pretty high
        delta += wrongThreshold * wrongThreshold;
      }

      const tokens = name.split(" ");
      for (let t of tokens) {
        tokenCount++;
        if (!bestTokenVocab.has(t)) outOfVocabTokens++;
      }
    }
    const missPercent = missCount / records.length;
    const rmse = Math.sqrt(delta / records.length);
    usersByScore.push({
      colorsCounted: colorCount,
      colorsWrong: wrongRate,
      colorsWrongPercent: wrongRate / colorCount,
      user: userId,
      error: rmse,
      missCount,
      missing: missPercent,
      votes: records.length,
      outOfVocabTokens,
      tokenCount,
      records,
    });
  }

  let remainingUsers = usersByScore.slice();
  const trolls0 = findOutOfVocab(remainingUsers, true);

  // const duplicators = findDuplicators(remainingUsers, true);
  // remainingUsers = remainingUsers.filter((f) => !duplicators.includes(f.user));
  // console.log("\n");

  // const trollUsers = findObviousTrolls(remainingUsers, true);
  // remainingUsers = remainingUsers.filter((f) => !trollUsers.includes(f.user));
  // console.log("\n");
}

function findOutOfVocab(usersByScore, debug = true) {
  const OOV = 0.75;
  const trolls = usersByScore
    .filter((f) => {
      return (
        f.missing >= 1 &&
        f.votes >= 5 &&
        f.outOfVocabTokens / f.tokenCount >= OOV
      );
    })
    .sort((a, b) => b.missing - a.missing);

  console.log(`Users who mostly respond with non-vocab words`);
  console.log(trolls.map((p) => p.user).join(","));

  if (debug) {
    for (let f of trolls) {
      printUser(f);
    }
  }
}

function findObviousTrolls(usersByScore, debug = false) {
  // we can filter out troll users by seeing if X% of their popular-name records (i.e. has minVotes=20 or something)
  // is far away from the expected mean. for example constantly putting 'gray' no matter what color is presented to them
  const minVotes = 5;
  const minCountedColors = 5;
  const P = 1;
  const worstDeltaUsers = usersByScore
    .slice()
    .filter((f) => f.votes >= minVotes && f.colorsCounted >= minCountedColors)
    .sort((a, b) => b.colorsWrongPercent - a.colorsWrongPercent)
    .filter((f) => f.colorsWrongPercent >= P);

  const users = worstDeltaUsers.map((n) => n.user);
  console.log(
    `Users who missed ${P * 100}% of color centroids by deltaEOK threshold:`,
  );
  console.log(users.join(","));

  if (debug) {
    for (let p of worstDeltaUsers) {
      printUser(p);
    }
  }
  return users;
}

function topLabelShare(records) {
  const counts = new Map();
  for (const r of records) counts.set(r, (counts.get(r) || 0) + 1);
  const max = Math.max(...counts.values());
  return max / records.length;
}

function findDuplicators(remainingUsers, debug = false) {
  const userSet = new Set();

  const types = [
    // P, minVotes, wrongPercent
    // [0.6, 5, null],
    [0.75, 5, null],
    [1, 4, 0.5],
    [1, 3, 0.5],
  ];
  for (let [P, minVotes, wrongPercent] of types) {
    for (let u of remainingUsers) {
      if (u.votes < minVotes) continue;
      const labels = u.records.map((i) => data[i].name);
      if (topLabelShare(labels) >= P) {
        if (wrongPercent != null) {
          if (u.colorsWrongPercent >= wrongPercent) userSet.add(u);
        } else {
          userSet.add(u);
        }
      }
    }
  }

  const users = [...userSet];

  console.log(`Users who have a top label share of >= N:`);
  console.log(users.map((n) => n.user).join(","));
  if (debug) {
    for (let p of users) {
      printUser(p);
    }
  }
  return users.map((p) => p.user);
}

function printUser(info) {
  let {
    user,
    error,
    missCount,
    missing,
    votes,
    colorsCounted,
    colorsWrong,
    records,
    outOfVocabTokens,
    tokenCount,
  } = info;
  const labels = records.map((i) => data[i].name);
  const strs = labels.join(",");
  const share = topLabelShare(labels);
  console.log(
    [
      `${user}:`,
      `share%:${Math.round(share * 100)}%`,
      `votes:${votes}`,
      `wrong:${colorsWrong}`,
      `of:${colorsCounted}`,
      `missing:${missCount}`,
      `(miss%=${Math.round(100 * missing)}%)`,
      `tokenOff%:${Math.round(100 * (outOfVocabTokens / tokenCount))}`,
      `\n${strs}\n`,
    ].join(" "),
  );
}

// const count = 2500;
// sorted.slice(0, count).forEach((row, i) => {
//   const name = row[0];
//   const count = row[1].length;
//   console.log(`${i}: ${name} (${count})`);
// });

function getTopVocabSet(nameMap, size = 2500) {
  const sorted = Array.from(nameMap.entries());
  sorted.sort((a, b) => b[1].length - a[1].length);
  return new Set(sorted.slice(0, size).map(([name]) => name));
}

function getColorCenterMap(colors) {
  return new Map(colors.map((c) => [c.name, c]));
}
