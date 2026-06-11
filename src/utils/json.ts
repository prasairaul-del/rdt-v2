export function safeParseJson<T>(text: string): T | null {
  const stripped = text
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(stripped) as T;
  } catch {
    // fall through
  }

  const firstObj = stripped.indexOf('{');
  const lastObj = stripped.lastIndexOf('}');

  const firstArr = stripped.indexOf('[');
  const lastArr = stripped.lastIndexOf(']');

  let first = -1;
  let last = -1;

  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    first = firstObj;
    last = lastObj;
  } else if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    first = firstArr;
    last = lastArr;
  }

  if (first !== -1 && last > first) {
    try {
      return JSON.parse(stripped.slice(first, last + 1)) as T;
    } catch {
      // fall through
    }
  }

  return null;
}
