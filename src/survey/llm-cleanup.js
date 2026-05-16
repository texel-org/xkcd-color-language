import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { getNameMap, loadDataFromJSON } from "./util/json.js";

dotenv.config();

// ---- config ----
const MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 100;
const N_SLICE_END = 10000;
const SOURCE_PATH = "data/xkcd/answers.compact.json";
const CAUGHT_PATH = "data/llm-caught.json";
const PROGRESS_PATH = "data/llm-progress.json";
const MAX_ATTEMPTS = 6; // total tries per batch before giving up
const BASE_DELAY_MS = 2000; // exponential backoff base (2s, 4s, 8s, 16s, 32s)
const MAX_DELAY_MS = 60_000; // cap each wait at 1min
const IS_BINARY_MODE = true;

// ---- prompt ----
const SYSTEM_PROMPT_BINARY = `You are reviewing color terms from a crowdsourced color-naming survey for quality control.

For each term, classify it as just YES or NO.

=== YES — a valid color name. Be GENEROUS. Includes: ===
- Plain color words, even uncommon or single-word ones: blue, manila, bile, oxblood, taupe, cerise, ochre, mauve, fawn
- Compound descriptive: dusty rose, rainy day, split pea soup, deep forest green, blue slate, clay gray
- Comparative forms: pinker, purpler, redder, bluer, greener, off green, not quite blue, almost blue, mid blue, med blue
- Suffixed color words (-ish, -y, -ey, -en, -ie all fine): greenish, pinky, bluey, reddy, golden, silvery, peachy, magentaish, purplish, orangey
- Slang/informal contractions: fluro green, fluro orange, neon blue
- Compounds combining informal forms: bluey gray, reddy brown, purply blue, greenish yellow
- Portmanteaus/mashups: breen, brorange, blellow, pinkle, bleen
- Cultural references and brand names: kermit, ups brown, windows xp blue, blue screen of death, bsod, 1970s dodge blue, hr block, xbox green, pepto pink, accountant blue
- Playful qualifier + color: yuck green, vomit green, icky green
- Standalone evocative words used as colors: icky, peachy, dusty, tawny, azul, swamp, cement, dust, bruise
- Articles allowed: "a dark pink"
- Numeric prefixes: "128 gray"
- Abstract/evocative: acid trip, achromatic bright purple, rainy day
- Some sickly things should pass as YES like seasick, toxic. Others might fall into NO
- Things like "dark dark blue" or "green blue" or "bluish green"

=== NO — insensitive, troll, swear, vulgar ===
- Curse words: shitbrown, fuck
- A clear spelling error: "bron", "browpn" etc. Note that portmanteaus like brorange are YES.
- Vulgarities: poop, spew, throwup, baby barf, vomit, pus, scab, snot, yuck
- Insensitive or racially targeted: white people, caucasian, chinese
- Other insensitive things like confederate clothing references
- Keyboard mash: adgasdgsadg, asdfasdf, qwerty, aghjob, uhhh, dfh
- Vulgar without color: shitbrown, fuckyou, titface, "bite me"
- Survey-meta: "next question", "repeat", "skip answer", "i don't know", "all", "tab", "your mom"
- Hex codes: fff, 0xfff, "#aabbcc"
- Negative-only without a color word: "vomit face", "yuck" (alone — but "yuck green" is YES)

=== Output ===
Return a single JSON array, no prose, no code fences. Echo each "label" EXACTLY as given.

[
  {"label": "darkred", "keep": "YES"},
  {"label": "asdfasdf", "keep": "NO"}
]

If every term is YES, output exactly: []`;

const SYSTEM_PROMPT_CLEAN = `You are reviewing color terms from a crowdsourced color-naming survey for quality control.

For each term, classify it as YES, MAYBE, or NO.

=== YES — a valid color name. Be GENEROUS. Includes: ===
- Plain color words, even uncommon or single-word ones: blue, manila, bile, oxblood, taupe, cerise, ochre, mauve, fawn
- Compound descriptive: dusty rose, rainy day, split pea soup, deep forest green, blue slate, clay gray
- Comparative forms: pinker, purpler, redder, bluer, greener
- Suffixed color words (-ish, -y, -ey, -en, -ie all fine): greenish, pinky, bluey, reddy, golden, silvery, peachy, magentaish, purplish, orangey
- Slang/informal contractions: fluro green, fluro orange, neon blue
- Compounds combining informal forms: bluey gray, reddy brown, purply blue, greenish yellow
- Portmanteaus: breen, brorange
- Cultural references and brand names: kermit, ups brown, windows xp blue, blue screen of death, bsod, 1970s dodge blue, hr block, xbox green, pepto pink, accountant blue
- Playful qualifier + color: yuck green, vomit green, icky green
- Standalone evocative words used as colors: icky, peachy, dusty, tawny, brick, grape, grass, petrol, mango, melon, cotton candy, milk chocolate brown, dead grass
- Articles allowed: "a dark pink"
- Numeric prefixes: "128 gray"
- Abstract/evocative: acid trip, achromatic bright purple, rainy day
- Capitalization variants in the source data are fine — if the only "issue" is uppercase letters in the original, it is still YES.

=== MAYBE — narrow. ONLY for: ===
1) clear missing-space concatenations of two color words: "darkred" → "dark red", "lightblue" → "light blue"
2) clear misspellings/typos of a color word: "birck red" → "brick red", "gry" → "gray", "turkuoise" → "turquoise", "orang" → "orange"

Do NOT use MAYBE for any of these — they are all YES with no suggestion:
fluro green, bile, manila, bluey gray, reddy brown, golden, purpler, magentaish, greenish, peachy, silvery, oxblood, taupe, mauve, ochre, neon, fluro

=== NO — troll, junk, or non-color content. ===
- Keyboard mash: adgasdgsadg, asdfasdf, qwerty, aghjob, uhhh, dfh
- Non-color words/names: adam, acool, hobo, chait, bieque beek, rawr
- Filler/expressions: ugh, idk, wtf, lol, aghhh
- Vulgar without color: shitbrown, fuckyou, titface, "bite me"
- Survey-meta: "next question", "repeat", "skip answer", "i don't know", "all", "tab", "your mom
- Offensive/identity-based: "white person", "chinese"
- Hex codes: fff, 0xfff, "#aabbcc"
- Negative-only without a color word: "vomit face", "yuck" (alone — but "yuck green" is YES)
- Bare numbers with no color word
- Clearly wrong language or made up words ("blau", etc)

=== Suggestion field — STRICT formatting ===
- Lowercase letters, digits, and spaces ONLY.
- NEVER use hyphens. Always "light blue", never "light-blue". Always "blue green", never "blue-green".
- No other punctuation.
- For NO entries: use "--" unless there is an obvious correction.
- YES entries are not included in your output at all.

=== Output ===
Return a single JSON array, no prose, no code fences. Echo each "label" EXACTLY as given.

[
  {"label": "darkred", "keep": "MAYBE", "suggestion": "dark red"},
  {"label": "asdfasdf", "keep": "NO", "suggestion": "--"}
]

If every term is YES, output exactly: []`;

// ---- helpers ----
async function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    console.warn(`Could not parse ${path}, using fallback:`, e.message);
    return fallback;
  }
}

async function writeJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

function extractText(response) {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function parseJSONArray(text) {
  // strip code fences if Claude added them despite instructions
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  // grab the first [...] block to be defensive
  const match = cleaned.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : cleaned);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;

      // honor server-supplied retry-after on rate limits, otherwise back off exponentially
      let delay;
      const retryAfter = Number(err?.headers?.["retry-after"]);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delay = Math.min(retryAfter * 1000, MAX_DELAY_MS);
      } else {
        delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
        delay += Math.floor(Math.random() * 750); // jitter
      }

      const msg = err?.message ?? String(err);
      const status = err?.status ? ` (HTTP ${err.status})` : "";
      console.warn(
        `  ! ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed${status}: ${msg.slice(0, 160)}` +
          ` — retrying in ${Math.round(delay / 100) / 10}s`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---- load source and build sorted term list ----
const src = await readFile(SOURCE_PATH, "utf8");
const json = JSON.parse(src);
const data = loadDataFromJSON(json);
console.log("Records:", data.length);

// const nameMap = getNameMap(data);
// const sorted = Array.from(nameMap.entries());
// sorted.sort((a, b) => b[1].length - a[1].length);
// console.log("Unique color names:", sorted.length);

// const terms = sorted.slice(0, N_SLICE_END).map(([t]) => t);

// terms.reverse(); // start with worst

const totalBatches = Math.ceil(terms.length / BATCH_SIZE);
console.log(
  `Processing top ${terms.length} terms in ${totalBatches} batches of ${BATCH_SIZE}.`,
);

// ---- load progress + existing caught list ----
const progress = await loadJSON(PROGRESS_PATH, { lastCompletedBatch: -1 });
const rawCaught = await loadJSON(CAUGHT_PATH, []);

let caught;
if (Array.isArray(rawCaught)) {
  caught = rawCaught;
} else if (rawCaught && typeof rawCaught === "object") {
  console.warn("Migrating legacy dict format in llm-caught.json to array.");
  caught = Object.entries(rawCaught).map(([label, v]) => ({
    label,
    keep: v?.keep,
    suggestion: typeof v?.suggestion === "string" ? v.suggestion : "",
  }));
} else {
  caught = [];
}
const seenLabels = new Set(caught.map((e) => e.label));

const startBatch = progress.lastCompletedBatch + 1;
console.log(
  `Resuming at batch ${startBatch} / ${totalBatches}. Already caught: ${caught.length}`,
);

if (startBatch >= totalBatches) {
  console.log(
    "All batches already complete. Delete data/llm-progress.json to re-run.",
  );
  process.exit(0);
}

// ---- main loop ----
const client = new Anthropic();

for (let batchIdx = startBatch; batchIdx < totalBatches; batchIdx++) {
  const start = batchIdx * BATCH_SIZE;
  const end = Math.min(start + BATCH_SIZE, terms.length);
  const batch = terms.slice(start, end);
  const batchSet = new Set(batch);

  const userPrompt =
    `Classify these ${batch.length} color terms. Return only the MAYBE and NO ones as a JSON array.\n\n` +
    batch.map((t, i) => `${i + 1}. ${t}`).join("\n");

  let lastResponse;
  let parsed;
  try {
    parsed = await withRetry(`batch ${batchIdx}`, async () => {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: [
          {
            type: "text",
            text: IS_BINARY_MODE ? SYSTEM_PROMPT_BINARY : SYSTEM_PROMPT_CLEAN,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
      });
      lastResponse = resp; // capture for usage logging below
      const text = extractText(resp);
      const arr = parseJSONArray(text);
      if (!Array.isArray(arr)) {
        const e = new Error(
          `response is not a JSON array. Preview: ${text.slice(0, 200)}`,
        );
        throw e;
      }
      return arr;
    });
  } catch (err) {
    console.error(
      `\nBatch ${batchIdx} failed after ${MAX_ATTEMPTS} attempts:`,
      err?.message ?? err,
    );
    console.error("Re-run the script to resume from this batch.");
    process.exit(1);
  }
  const response = lastResponse;

  // merge with hallucination filter
  let added = 0,
    hallucinated = 0,
    skipped = 0,
    duped = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      skipped++;
      continue;
    }
    // accept either "label" or "term" from the LLM, just in case
    const label = typeof entry.label === "string" ? entry.label : entry.term;
    const { keep } = entry;
    let suggestion =
      typeof entry.suggestion === "string" ? entry.suggestion : "";
    if (typeof label !== "string" || !batchSet.has(label)) {
      hallucinated++;
      continue;
    }
    if (keep !== "MAYBE" && keep !== "NO") {
      skipped++;
      continue;
    }
    if (seenLabels.has(label)) {
      duped++;
      continue;
    }
    if (label == entry.suggestion) {
      console.log("same suggestion:", label);
      continue;
    }
    // defensive normalization: enforce no hyphens, lowercase, trim
    suggestion = suggestion
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    caught.push({ label, keep, suggestion });
    seenLabels.add(label);
    added++;
  }

  // persist after success
  await writeJSON(CAUGHT_PATH, caught);
  await writeJSON(PROGRESS_PATH, {
    lastCompletedBatch: batchIdx,
    totalBatches,
    lastUpdated: new Date().toISOString(),
  });

  const usage = response.usage ?? {};
  console.log(
    `[${batchIdx + 1}/${totalBatches}] +${added} caught` +
      (hallucinated ? `, ${hallucinated} hallucinations dropped` : "") +
      (duped ? `, ${duped} duped` : "") +
      (skipped ? `, ${skipped} skipped` : "") +
      `  | total caught: ${caught.length}` +
      `  | tokens in/out: ${usage.input_tokens ?? "?"}/${usage.output_tokens ?? "?"}` +
      (usage.cache_read_input_tokens
        ? ` (cache read ${usage.cache_read_input_tokens})`
        : ""),
  );
}

console.log(
  `\nDone. ${caught.length} terms flagged across ${totalBatches} batches.`,
);
console.log(`Results: ${CAUGHT_PATH}`);
