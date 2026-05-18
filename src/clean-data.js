import { createReadStream, writeFileSync } from "node:fs";
import csv from "csv-parser";
import { readFile } from "node:fs/promises";
import {
  JUNK_VOWELLESS_OK,
  JUNK_TOKEN_ALLOWLIST,
  TYPO_MAP,
  SWAP_MAP,
  EXTRA_CURSES,
  SKIP_LABELS,
  SPAM_USERS,
  SKIP_TERMS,
  SUSPECT_TOKENS,
  DECENT_LONG_NAMES,
  NON_CURSES,
} from "./survey/constants.js";
import * as path from "node:path";
import {
  getNameMap,
  getUserMap,
  loadDataFromJSON,
  Frequencies,
} from "./util/json.js";

const MAX_LENGTH = 30;
const MAX_TOKENS = 3;
const SPAM_TOKEN_LENGTH = 8;
// const typoMap = new Map(TYPO_MAP);
// const skip = new Set(SKIP_LABELS);

const curses = (await readFile("data/curses_en.txt", "utf8"))
  .split("\n")
  .map((n) => n.toLowerCase().trim())
  .filter(Boolean);

const curseSet = new Set(curses);
for (let c of EXTRA_CURSES) {
  curseSet.add(c);
}
for (let c of NON_CURSES) {
  curseSet.delete(c);
}

function loadUserSets() {
  const colorBlindUsers = new Set();
  const nonEnglishUsers = new Set();
  let cb;
  let promise = new Promise((resolve) => {
    cb = resolve;
  });
  createReadStream("data/xkcd/users.csv")
    .pipe(csv())
    .on("data", (row) => {
      const lang = (row.language || "").trim();
      if (lang && !/(en|english)/i.test(lang)) {
        nonEnglishUsers.add(Number(row.id));
      }
      if (row.colorblind == "1") {
        colorBlindUsers.add(Number(row.id));
      }
    })
    .on("end", () => {
      console.log("Non English: %d users", nonEnglishUsers.size);
      console.log("Colorblind: %d users", colorBlindUsers.size);
      cb({ colorBlindUsers, nonEnglishUsers });
    });
  return promise;
}

function loadAnswers(opts = {}) {
  const {
    debug = false,
    colorBlindUsers = new Set(),
    nonEnglishUsers = new Set(),
    skipColorBlind = false,
    skipNonEnglish = false,
  } = opts;

  const likelySpammers = new Set();
  const spamlikeNameMap = new Map();
  const userVoteCount = new Map();

  const freqs = {
    hex: Frequencies(),
    junk: Frequencies(),
    short: Frequencies(),
    nonAlpha: Frequencies(),
    longChars: Frequencies(),
    longTokens: Frequencies(),
    spamTokenLength: Frequencies(),
    suspect: Frequencies(),
    i: Frequencies(),
    it: Frequencies(),
    curses: Frequencies(),
  };

  let cb;
  let promise = new Promise((resolve) => {
    cb = resolve;
  });
  const rows = [];
  createReadStream("data/xkcd/answers.csv")
    .pipe(csv())
    .on("data", (row) => {
      const userId = Number(row.user_id);

      if (skipColorBlind && colorBlindUsers.has(userId)) {
        return;
      }
      if (skipNonEnglish && nonEnglishUsers.has(userId)) {
        return;
      }

      if (!SPAM_USERS.has(userId)) {
        if (userVoteCount.has(userId)) {
          userVoteCount.set(userId, userVoteCount.get(userId) + 1);
        } else {
          userVoteCount.set(userId, 1);
        }
        const r = Math.max(0, Math.min(0xff, parseInt(row.r, 10)));
        const g = Math.max(0, Math.min(0xff, parseInt(row.g, 10)));
        const b = Math.max(0, Math.min(0xff, parseInt(row.b, 10)));
        const name = row.colorname;
        const rgb = (r << 16) | (g << 8) | b;
        const result = cleanup(userId, rgb, name);
        if (result) rows.push(result);
      }
    })
    .on("end", () => {
      cb(rows);

      if (debug) {
        debugFrequencies();
        console.log("==== DEBUG: SPAMMERS =====");
        findSpammers(rows);
        console.log();
      }
    });
  return promise;

  function debugFrequencies() {
    const MIN_VOTES = 5;
    const MAX_COUNT = 25;
    console.log(`===== DEBUG FREQUENCIES (MAX_COUNT=${MAX_COUNT}) =====`);
    for (let [key, fmap] of Object.entries(freqs)) {
      console.log(`===== "${key}" =====`);
      const sorted = fmap
        .getSortedEntries()
        .filter((f) => f[1] >= MIN_VOTES)
        .slice(0, MAX_COUNT);
      if (sorted.length == 0)
        console.log(`(none above MIN_VOTES=${MIN_VOTES})`);
      else {
        for (let [label, count] of sorted) {
          console.log(`${label} (${count})`);
        }
      }
      console.log();
    }
  }

  function markSpam(userId, name) {
    if (spamlikeNameMap.has(userId)) {
      spamlikeNameMap.get(userId).push(name);
    } else {
      spamlikeNameMap.set(userId, [name]);
    }
    likelySpammers.add(userId);
  }

  function findSpammers(rows) {
    console.log("Possible Spam Users:");
    const byUser = getUserMap(rows);
    const moreSpammers = new Set();
    for (let id of likelySpammers) {
      if (SPAM_USERS.has(id)) continue; // already marked
      const res = byUser.get(id);
      if (res) {
        const voteCount = userVoteCount.get(id);
        const spams = spamlikeNameMap.get(id);
        const percentSpam = spams.length / voteCount;
        if (percentSpam > 0.5) {
          console.log(id);
          console.log(spams);
          console.log();
          moreSpammers.add(id);
        }
      } else {
        // user might already have been culled off
      }
    }

    console.log("Additional spammer IDs:");
    console.log([...moreSpammers].join(","));
  }

  function cleanup(userId, rgb, name) {
    if (!name) return false;
    if (name.includes("[URL REDACTED]")) {
      markSpam(userId, name);
      return false;
    }
    if (name.includes("[EMAIL REDACTED]")) {
      markSpam(userId, name);
      return false;
    }
    if (name.length > MAX_LENGTH) {
      if (!DECENT_LONG_NAMES.has(name)) {
        markSpam(userId, name);
        freqs.longChars.add(name);
        return false;
      }
    }

    const originalLabel = name;
    name = name.toLowerCase();
    name = name.normalize("NFKC").trim();

    if (
      name.startsWith("#") ||
      name.startsWith("0x") ||
      /^(#|0x)?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(name)
    ) {
      // hex code, might be interesting but let's skip for our language usage..
      freqs.hex.add(name);
      return false;
    }

    if (/[\:\;]/.test(name)) {
      // with this we lose some valid entries like "blue:  cornflower"
      // or "light maroon (class: purple)" but most entries with this are low quality
      return false;
    }

    // teal-y --> tealy
    name = name.replace(/\b([a-z]+)\-y\b/g, "$1y");

    // another blue --> blue
    name = name.replace(/^another\s+/, "");

    name = name
      .replace(/['’]/g, "")
      .replace(/[\/_,]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\s*-\s*/g, "-")
      .replace(/[^a-z0-9 -]/g, "")
      .replace(/[\-]/g, " ")
      .trim();

    if (name.length <= 2) {
      freqs.short.add(name);
      return false;
    }
    if (!/[a-z\s]+/gi.test(name)) {
      freqs.nonAlpha.add(name);
      markSpam(userId, name);
      return false;
    }

    // unless it's the brand name grey poupon, replace with gray
    if (!name.includes("poupon")) {
      name = name.replaceAll("grey", "gray");
    }

    // special case: normalise "gray ish blue" and "grayish blue"
    // we have some typo stuff to handle "blueish" vs "bluish"
    if (name.includes(" ish")) {
      name = name.replace(/\s+(ish)\b/, "ish");
    }

    // "a dark red" --> "dark red"
    name = name.replace(/^a\s/, "");

    // fix typos
    if (TYPO_MAP.has(name)) {
      name = TYPO_MAP.get(name);
    }

    if (curseSet.has(name)) {
      markSpam(userId, name);
      freqs.curses.add(name);
      return false;
    }
    let tokens = name.split(/\s+/g);

    if (tokens.some((word) => curseSet.has(word))) {
      markSpam(userId, name);
      freqs.curses.add(name);
      return false;
    }
    if (tokens.length >= SPAM_TOKEN_LENGTH) {
      markSpam(userId, name);
      freqs.spamTokenLength.add(name);
      likelySpammers.add(userId);
    }

    // if the label matches exactly, skip it
    if (SKIP_LABELS.has(name)) return false;

    tokens = tokens.map((token) => {
      // fix typos per token
      if (TYPO_MAP.has(token)) return TYPO_MAP.get(token);
      return token;
    });

    // if the label or any of the tokens matches these terms, skip it
    if (SKIP_TERMS.has(name)) return false;
    if (tokens.some((t) => SKIP_TERMS.has(t))) {
      return false;
    }

    if (name.includes("faggy") || name.includes("homosexual")) {
      console.log("HOW?!??!", name);
    }

    if (tokens.includes("i")) {
      // i quit, i dunno, etc
      freqs.i.add(name);
      return false;
    }

    if (tokens.includes("it") && !tokens.includes("post")) {
      // anything with "it" but allow "post it"
      freqs.it.add(name);
      return false;
    }

    if (!tokens.length) return false;
    if (tokens.length > 1 && /colou?rs?/.test(tokens[tokens.length - 1])) {
      // remove last, "barney color" -> "barney"
      tokens.pop();
    }

    if (tokens.join(" ") == "not a") {
      // filter out 'not a color' labels
      return false;
    }

    // still green -> green
    if (tokens.length > 1 && tokens[0] == "still") {
      tokens.shift();
    }

    // more green -> green
    if (tokens.length > 1 && tokens[0] == "more") {
      tokens.shift();
    }

    // green again -> green
    if (tokens.length > 1 && tokens[tokens.length - 1] == "again") {
      tokens.pop();
    }

    // some entries are just "color" on their own
    if (tokens.length == 1 && /colou?rs?/.test(tokens[0])) return false;

    const isDecentLongName = DECENT_LONG_NAMES.has(name);

    if (!isDecentLongName && tokens.length > MAX_TOKENS) {
      freqs.longTokens.add(name);
      return false;
    }

    // a little aggressive but trying to remove things like "not again" or "when will this end"
    if (!isDecentLongName && tokens.some((t) => SUSPECT_TOKENS.has(t))) {
      freqs.suspect.add(name);
      return;
    }

    name = tokens.join(" ");

    // check skip again now that we've cleaned the tokens
    if (SKIP_TERMS.has(name)) return false;
    if (SKIP_LABELS.has(name)) return false;

    // this is too aggressive; some "blue or purple" are quite good names
    // if (tokens.includes("or")) {
    //   // "violet or indigo" type of responses
    //   return false;
    // }

    if (SWAP_MAP.has(name)) {
      name = SWAP_MAP.get(name);
    }

    if (isJunkLabel(name)) {
      freqs.junk.add(name);
      return false;
    }

    const row = [userId, rgb, name];
    if (name !== originalLabel) row.push(originalLabel);
    return row;
  }
}

function isJunkLabel(label) {
  const s = label;
  // too short to be a real color label, e.g. "ab", "x"
  if (s.length < 3) return true;
  // 4+ of the same character in a row, e.g. "ggggggg", "uuuuuuuu", "kkkkk"
  if (/(.)\1{3,}/.test(s)) return true;

  const tokens = s.split(/\s+/).filter(Boolean);

  for (const t of tokens) {
    // skip all rules for known-good tokens like "lightsteelblue", "mcdonalds", "sprng"
    if (JUNK_TOKEN_ALLOWLIST.has(t)) continue;
    // interleaved letter/digit mash within one token, e.g. "h74yrf5", "1muk4gvyki4", "xsujq32f"
    // (allows real labels like "1980s house pink", "90s royal blue" since the mix is across tokens)
    if (t.length >= 4 && /[a-z]\d/.test(t) && /\d[a-z]/.test(t)) return true;

    // alpha-prefix-then-digits keysmash, e.g. "xiuftg0", "hktgd8" (low vowel ratio + trailing digits)
    const m = t.match(/^([a-z]{5,})\d+$/);
    if (m && vowelRatio(m[1]) < 0.25) return true;

    const letters = t.replace(/[^a-z]/g, "");

    // 4-6 letter token with zero real vowels, e.g. "skjgf", "kjgf", "efw", "jkg"
    // (allowlist exempts legit acronyms like "html", "tmnt", "nypd", "http")
    if (
      letters.length >= 4 &&
      letters.length < 7 &&
      !/[aeiou]/.test(letters) &&
      !JUNK_VOWELLESS_OK.has(letters)
    )
      return true;

    // strip silent-h digraphs (gh, sh, ph, th, ch, etc.) so words like
    // "flashlight", "twighlight", "highlighter" aren't unfairly penalized below
    const stripped = letters.replace(/([bcdfgkpstw])h/g, "$1");

    // long token with very few vowels (counting r/y as vowel-equivalent),
    // e.g. "fghnjzdughtsi", "efwjgkfewgkj", "ashrabyjobn"
    if (stripped.length >= 7 && vowelRatio(stripped) < 0.22) return true;

    // long token with multiple hard consonant clusters of 3+,
    // e.g. "ihgoisugh"-style mashing; catches gibberish that slips past the vowel check
    if (stripped.length >= 8) {
      const hardClusters = (stripped.match(/[bcdfgjklmnpqstvwxz]{3,}/g) || [])
        .length;
      if (hardClusters >= 2) return true;
    }
  }
  return false;
}

function vowelRatio(s) {
  const v = (s.match(/[aeiouyr]/g) || []).length;
  return v / s.length;
}

if (import.meta.main || process.argv[1] === import.meta.filename) {
  const { colorBlindUsers, nonEnglishUsers } = await loadUserSets();

  const args = process.argv.slice(2);
  const skipColorBlind = args.includes("--skip-color-blind");
  const skipNonEnglish = args.includes("--english-only");
  const debug = args.includes("--debug");

  let rows = await loadAnswers({
    colorBlindUsers,
    nonEnglishUsers,
    skipColorBlind,
    skipNonEnglish,
    debug,
  });

  writeFileSync("data/xkcd/answers.compact.json", JSON.stringify(rows));
  console.log(`wrote ${rows.length} rows`);
}
