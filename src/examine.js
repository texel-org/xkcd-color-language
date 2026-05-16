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

const src = await readFile("data/xkcd/answers.compact.json", "utf8");
const rows = JSON.parse(src);

// const data = loadDataFromJSON(rows);
// console.log("Total Records:", data.length);

const filtered = rows;
const filterFreqs = Frequencies();
for (let r of rows) {
  filterFreqs.add(r[2]);
}

// console.log(rows.filter((r) => r[3] == "grey-pink"));

const topK = filterFreqs.getSortedEntries().slice(0, 5000);
const topKNames = new Set(topK.map((n) => n[0]));
const typoMap = new Map();

// for (let t of topK) {
//   console.log(`${t[0]} (${t[1]})`);
// }

// For the top K filtered results, find results
// that were popular but filtered out

const SHOW_ONLY_DELS = true;
console.log("Loading All Records");
const allRecords = await loadAnswers();
const allFreqs = Frequencies();
for (let r of allRecords) allFreqs.add(r[2]);
const topKAll = 10_000;
const allEntries = allFreqs.getSortedEntries().slice(0, topKAll);
console.log("Missing Entries:");
for (let t of allEntries) {
  const name = t[0];
  if (!topKNames.has(name)) {
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

    const isShow = SHOW_ONLY_DELS ? !typo : true;
    if (isShow) {
      const suffix = typo ? typo : "(del)";
      console.log(`${t[0]} (${t[1]}) --> ${suffix}`);
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
