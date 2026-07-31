// Shared greeting helper — the single correctness seam for how Aegis addresses a
// person by name. Every employee- and manager-facing message that opens with a
// name MUST build it from here, so name-extraction (and the safe fallback for a
// missing name) lives in exactly one place.
//
// firstName: trimmed first whitespace-delimited token; 'there' when the name is
//            null/undefined/empty/whitespace-only.
// greeting:  `Hi ${firstName(name)},` — the opening line itself.

export function firstName(name?: string | null): string {
  if (!name) return 'there';
  const first = name.trim().split(/\s+/)[0];
  return first.length > 0 ? first : 'there';
}

export function greeting(name?: string | null): string {
  return `Hi ${firstName(name)},`;
}

// textOpener: the warm, inline opener for TEXT/SMS replies. The email-style
// `greeting()` header ("Hi Sam,\n\n<body>") reads too formal in a text thread, so
// text replies weave the name in with an em-dash lead ("Hey Sam — <body>").
// Manager notification EMAILS deliberately keep `greeting()` — a greeting header
// is conventional in email. Use this for any message a person reads as a text.
export function textOpener(name?: string | null): string {
  const f = firstName(name);
  return f === 'there' ? 'Hey — ' : `Hey ${f} — `;
}
