// Tolerant JSON-object reader for LLM output.
//
// Models occasionally wrap their JSON in ```json fences or add a sentence of
// preamble ("Sure, here you go: {...}"). A bare JSON.parse throws on those, and
// callers that catch-and-fall-back then silently lose ALL extracted fields —
// which has caused real misreads (e.g. a coverage name reply being treated as a
// decline). This strips fences and grabs the first {...} block before parsing.
//
// Returns null when nothing parseable is found, so callers keep their existing
// fallback behavior. Use this anywhere we parse a model's JSON response; it is
// NOT needed for parsing JSON we wrote ourselves (e.g. session rows in the DB).
export function coerceJsonObject<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  let t = text.trim();
  // Strip a leading ```json / ``` fence and a trailing ``` fence.
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // If there's surrounding prose, grab the first {...} object block.
  const m = t.match(/\{[\s\S]*\}/);
  if (m) t = m[0];
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}
