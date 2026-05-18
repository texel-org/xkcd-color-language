export const CURATE_MAX = 5000;

export function isFlagged(token) {
  if (LABEL_CURATE_EXACT_SKIP.has(token)) return true;
  if (LABEL_CURATE_SKIP.has(token)) return true;
  if (token.split(" ").some((n) => LABEL_CURATE_SKIP.has(n))) {
    return true;
  }
  return false;
}

export const LABEL_CURATE_EXACT_SKIP = new Set([
  "doo doo brown",
  "white man",
  "human flesh",
  "little girl pink",
  "throw up",
  "throw up green",
  "throw up yellow",
  "bloody stool",
  // a few that are more opinionated skips, these represent really poorly formed colors
  "not yellow",
  "nothing",
]);

export const LABEL_CURATE_SKIP = new Set([
  "skinish",
  "bogey",
  "snotty",
  "barf",
  "vomit",
  "bubonic",
  "pukier",
  "vomity",
  "diarrhea",
  "mucus",
  "skin",
  "flesh",
  "pukish",
  "confederate",
  "booger",
  "pukey",
  "puke",
  "phlegm",
  "marijuana",
  "throwup",
  "caucasion",
  "caucasian",
  "sick",
  "dung",
  "pus",
  "spew",
  "poopy",
  "scab",
  "jaundice",
  "gangrene",
  "red",
  "snot",
  "urine",
  "mold",
  "mould",
  "fleshy",
  "stripper",
  "puss",
  "body",
  "pee",
  "hippie",
  "hippy",
  "gore",
  "puky",
  "placenta",
  "congo",
  "gas",
  "toilet",
  "nude",
  "poop",
  "poo",
  "piss",
  "turd",
  "salmonella",
  "vomitous",
  "doodoo",
  "skidmark",
  "fleshlight",
  "vomitus",
  "girly",
  "manly",
  "girlish",
  "boyish",
  "stool",
  "pimpin",
  "mucous",
  "barfy",
  "meconium", // nice one though
  "puky",
  "tampon red",
  // "karitane yellow", // keep or no?
]);
