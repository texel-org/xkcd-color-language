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
// import { TOKEN_ALLOW } from "./survey/constants.js";

const src = await readFile("data/xkcd/answers.compact.json", "utf8");
const rows = JSON.parse(src);
const data = loadDataFromJSON(rows);
console.log("Total Records:", data.length);

let colors = convert(data, {
  minUsers: 4,
  maxCount: 15000,
  curated: false,
  sort: "users",
});

await checkMissing(rows, colors);

async function checkMissing(rows, colors) {
  const nameMap = new Set(colors.map((n) => n.name));
  const typoMap = new Map();

  const findCorrection = (name) => {
    let typo;
    if (typoMap.has(name)) {
      typo = typoMap.get(name);
    } else {
      const fixed = rows.find((r) => {
        return r[3] == name;
      });
      if (fixed) {
        const fixedName = fixed[2];
        typo = fixedName;
        typoMap.set(name, fixedName);
      }
    }
    return typo;
  };

  console.log("Loading full dataset...");
  const allRecords = await loadAnswers();
  console.log("All uncleaned records:", allRecords.length);
  const namesToUniqUsers = new Map();
  for (let c of allRecords) {
    const userId = c[0];
    const name = c[2];
    if (namesToUniqUsers.has(name)) {
      const set = namesToUniqUsers.get(name);
      set.add(userId);
    } else {
      namesToUniqUsers.set(name, new Set([userId]));
    }
  }
  let sorted = [...namesToUniqUsers.entries()];
  sorted.sort((a, b) => {
    return b[1].size - a[1].size;
  });
  sorted = sorted.slice(0, 10000);
  for (let i = 0; i < sorted.length; i++) {
    const [name, users] = sorted[i];
    if (nameMap.has(name)) continue; // exists in curated set

    const cleaned = name
      .toLowerCase()
      .normalize("NFKC")
      .replace(/['’]/g, "")
      .replace(/[\/_,]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\s*-\s*/g, "-")
      .replace(/[^a-z0-9 -]/g, "")
      .replace(/[\-]/g, " ")
      .trim();

    // const show =
    //   TOKEN_ALLOW.has(cleaned) ||
    //   cleaned.split(" ").some((t) => TOKEN_ALLOW.has(t));
    // if (!show) continue;

    const SHOW_ONLY_DELS = true;
    const typo = findCorrection(name);
    const isShow = SHOW_ONLY_DELS ? !typo : true;
    if (isShow) {
      const suffix = typo ? typo : "(del)";
      console.log(
        `${String(i).padStart(5, "0")}: ${name} (${users.size}) --> ${suffix}`,
      );
    }
  }
}

function loadAnswers(opts = {}) {
  let cb;
  let promise = new Promise((resolve) => {
    cb = resolve;
  });
  const rows = [];
  createReadStream("data/xkcd/answers.csv")
    .pipe(csv())
    .on("data", (row) => {
      const userId = Number(row.user_id);
      const r = Math.max(0, Math.min(0xff, parseInt(row.r, 10)));
      const g = Math.max(0, Math.min(0xff, parseInt(row.g, 10)));
      const b = Math.max(0, Math.min(0xff, parseInt(row.b, 10)));
      const name = row.colorname;
      const rgb = (r << 16) | (g << 8) | b;
      const result = [userId, rgb, name];
      if (result) rows.push(result);
    })
    .on("end", () => {
      cb(rows);
    });
  return promise;
}

// to check:
// murple
// lait
// agua
// azul
// "malva",
// navi
//grayple
//catachan
//tarheel
//midori
//tardis
//marino
//meconium
//schwarz
//roi
//altrosa
