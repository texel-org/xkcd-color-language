const LABEL_CURATE_EXACT_SKIP = new Set([
  "doo doo brown",
  "white man",
  "human flesh",
  "little girl pink",
  "throw up",
  "throw up green",
  "throw up yellow",
  "bloody stool",
  // a few that are more opinionated skips, these represent really poorly formed colors
  "nothing",
]);

const LABEL_CURATE_SKIP = new Set([
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
  // "nude", // allow
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
  "puky",
  "tampon red",
  "meconium", // maybe allow?
  // "karitane yellow", // keep or no?
]);

// things that might have 'bad words' but are probably good colors
const LABEL_EXACT_ALLOW_LIST = new Set([
  "alien skin",
  "peach skin",
  // 'sunburned skin', // consider allowing?
  "skin peach",
  "sharkskin",
  "pumpkin skin",
  "orange skin",
  "peach flesh",
  "pig flesh",
  "orange flesh",
  "zombie flesh",
  "elf flesh",
  "peach skin tone",
  "pig skin",
  "zombie skin",
  "tan skin",
  "buckskin",
  "pigskin",
  "moleskin",
]);

export function isFlagged(name) {
  if (LABEL_EXACT_ALLOW_LIST.has(name)) return false;
  if (LABEL_CURATE_EXACT_SKIP.has(name)) return true;
  if (LABEL_CURATE_SKIP.has(name)) return true;
  if (name.split(" ").some((n) => LABEL_CURATE_SKIP.has(n))) {
    return true;
  }
  return false;
}
