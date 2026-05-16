export function loadDataFromJSON(json) {
  return json.map((row) => {
    const hex = "#" + row[1].toString(16).padStart(6, "0");
    const data = {
      user: row[0],
      hex,
      name: row[2],
      initialName: row[3] || row[2],
    };
    // optional: we could inject the original name here too if needed
    return data;
  });
}

export function Frequencies() {
  const map = new Map();
  return {
    getSortedEntries(desc = true) {
      const entries = [...map.entries()];
      entries.sort((a, b) => {
        if (desc) return b[1] - a[1];
        else return a[1] - b[1];
      });
      return entries;
    },
    add(term) {
      if (map.has(term)) {
        map.set(term, map.get(term) + 1);
      } else {
        map.set(term, 1);
      }
    },
    get map() {
      return map;
    },
  };
}

export async function loadData(url) {
  const json = await (await fetch(url)).json();
  return loadDataFromJSON(json);
}

export function getUserMap(data) {
  const userMap = new Map();
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    if (userMap.has(d.user)) {
      userMap.get(d.user).push(i);
    } else {
      userMap.set(d.user, [i]);
    }
  }
  return userMap;
}

export function getNameMap(data) {
  const nameMap = new Map();
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    if (nameMap.has(d.name)) {
      nameMap.get(d.name).push(i);
    } else {
      nameMap.set(d.name, [i]);
    }
  }
  return nameMap;
}
