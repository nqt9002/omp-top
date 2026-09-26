/** Extract the first complete JSON object/array from noisy CLI output. */
export function extractJsonPayload(text) {
  if (!text) return null;
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  let start = -1;
  let open = "";
  let close = "";
  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
    start = objectStart;
    open = "{";
    close = "}";
  } else if (arrayStart >= 0) {
    start = arrayStart;
    open = "[";
    close = "]";
  }
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseNoisyJson(text, label = "command") {
  const json = extractJsonPayload(text);
  if (!json) throw new Error(`${label} returned no JSON payload`);
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
