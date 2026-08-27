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

// managerAlertSms: ONE voice for every manager NOTIFICATION text. A manager alert
// should never read like a dumb "you have 1 notification" — it leads with the who /
// what / when / why so the manager can decide from the text alone whether to open
// their inbox now or later, then hands off warmly to the email where the actual
// approve/deny (or detail) lives. `summary` is that informative line; `inbox` names
// what's waiting so the hand-off is specific, not generic. Omit `inbox` for a pure FYI.
export function managerAlertSms(params: {
  managerName?: string | null;
  summary: string;
  // 'decide' — the email offers MORE than approve/deny (W-2 call-outs carry
  // three choices), so the 'approve' tail's "approve/deny link" would be a lie.
  inbox?: 'approve' | 'action' | 'details' | 'decide' | null;
}): string {
  const { managerName, summary, inbox } = params;
  const tail =
    inbox === 'approve'
      ? " I've put the details and an approve/deny link in your email — take a look whenever you get a chance."
      : inbox === 'action'
      ? " The details and how to handle it are in your email whenever you get a chance."
      : inbox === 'details'
      ? " Full details are in your email if you want them."
      : inbox === 'decide'
      ? " The details and your options are in your email — take a look when you can."
      : '';
  return `${textOpener(managerName)}${summary}${tail}`;
}
