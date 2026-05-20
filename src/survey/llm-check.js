import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as Color from "@texel/color";
import {
  getNameMap,
  getUserMap,
  loadData,
  loadDataFromJSON,
} from "../util/json.js";
import { deltaEOK2, prepareData } from "../util/data.js";

const src = await readFile("data/xkcd/answers.clean.json", "utf8");
const json = JSON.parse(src);

const data = loadDataFromJSON(json);
console.log("Count:", data.length);

const poorLabels = JSON.parse(await readFile("data/llm-caught.json", "utf8"));

console.log("----- TYPOS");
const typos = [];
for (let { label, keep, suggestion } of poorLabels) {
  if (keep == "MAYBE" && suggestion) {
    typos.push([label, suggestion]);
  }
}
console.log(JSON.stringify(typos, null, 2));

console.log("----- SKIPS");
console.log(
  JSON.stringify(
    poorLabels.filter((s) => s.keep == "NO").map((n) => n.label),
    null,
    2,
  ),
);
