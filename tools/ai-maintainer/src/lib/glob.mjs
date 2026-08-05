function escapeRegex(character) {
  return /[\\^$+?.()|{}\[\]]/.test(character) ? `\\${character}` : character;
}

export function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      const next = pattern[index + 1];
      if (next === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegex(character);
    }
  }
  expression += "$";
  return new RegExp(expression);
}

const cache = new Map();

export function matchesGlob(filePath, pattern) {
  const key = pattern;
  if (!cache.has(key)) cache.set(key, globToRegExp(pattern));
  return cache.get(key).test(filePath.replaceAll("\\", "/"));
}

export function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}
