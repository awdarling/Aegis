// Pure word-level detectors shared by the classifier backstop (ai/claude.ts) and
// onboarding (workflows/employee-onboarding.ts). No I/O, no model.

// A message that states ONLY when the employee CAN work — with no off/can't
// language — is an availability statement, never a time-off request.
//
// W-1 branch 2 (J-1b): "I can ONLY work …" / "I can just do …" are the commonest
// phrasings and used to slip through — Mia Shaffer's onboarding answer ("Next
// week I can only work pm shifts Monday through Friday") became a time-off
// request because the word "only" broke the "i can work" match.
export function looksLikePositiveAvailability(body: string): boolean {
  const positive = /\bi can (?:only |just )?work\b|\bi can (?:only |just )?do\b|\bi['’ ]?a?m (?:only )?available\b|\bavailable to work\b|\bput me down for\b|\bi['’ ]?a?m free\b/i.test(body);
  if (!positive) return false;
  const negative = /\boff\b|\bcan['’]?t\b|\bcannot\b|\bcan ?not\b|\bunavailable\b|\bno more\b|\btake me off\b|\bneed[s]?\b.*\boff\b/i.test(body);
  return !negative;
}
