import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as Color from "@texel/color";
import {
  getNameMap,
  getUserMap,
  loadData,
  loadDataFromJSON,
  postClean,
} from "../util/json.js";
import { deltaEOK2, prepareData } from "../util/data.js";

const src = await readFile("data/xkcd/answers.compact.json", "utf8");
const json = JSON.parse(src);

const data = loadDataFromJSON(json);
console.log("Count:", data.length);

console.log("Getting named colors...");
const nameMap = getNameMap(data);
// const sorted = Array.from(nameMap.entries());
// sorted.sort((a, b) => {
//   return b[1].length - a[1].length;
// });
// console.log("Color Count:", sorted.length);

// const N = 5000;
// for (let i = 0; i < N; i++) {
//   console.log(`${i}: ${sorted[i][0]} (${sorted[i][1].length})`);
// }

const poorLabels0 = JSON.parse(await readFile("data/llm-caught.json", "utf8"));
const poorLabels1 = JSON.parse(
  await readFile("data/llm-caught-v0/llm-caught.json", "utf8"),
);

const poorLabels = [];
const merge = (list, nextList) => {
  for (let item of nextList) {
    const { label, keep, suggestion } = item;
    const other = list.find((n) => n.label == label);
    if (other && (other.keep !== keep || other.suggestion !== suggestion)) {
      // console.log("Merge Conflict:", other, item);
      // skip
    } else {
      list.push(item);
    }
  }
};

merge(poorLabels, poorLabels0);
// merge(poorLabels, poorLabels1);

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

// const count = nameMap.get(label).length;
// if (keep == "MAYBE") {
//   console.log(`${label} [${count}] (${keep}) --> ${suggestion}`);
// } else if (keep == "NO") {
//   console.log(`${label} [${count}] (${keep}) --> ${suggestion}`);
// }
