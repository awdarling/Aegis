// Shared natural yes/no parser. Conversational confirmations ("Want me to run it
// by Riley?", "Want me to change it to 32?") should accept real replies, not a
// literal "yes": "yeah do it", "go for it", "send it", "sounds good" all confirm;
// "not quite", "hold on", "never mind" all decline. Mirrors the parser the swap +
// time-off flows use, so voice is consistent across workflows.
// (Consolidation note: shift-swap.ts still has its own copy — migrate it here in a
//  later pass; left untouched now to avoid churn on in-flight branches.)
export function parseYesNo(body: string): 'yes' | 'no' | 'unclear' {
  const lower = body.trim().toLowerCase();
  if (/^(yes|yeah|yea|yep|yup|sure|ok|okay|correct|confirm(ed)?|that'?s right|right|send(?: it| that| it over)?|go (?:ahead|for it)|do it|please do|please|sounds good|looks good|that works|perfect|great|\u{1F44D})/u.test(lower)) return 'yes';
  if (/^(no|nope|nah|can'?t|cannot|wrong|incorrect|cancel|don'?t|not (?:quite|right|yet)|never ?mind|hold on|wait|stop|forget it)/.test(lower)) return 'no';
  return 'unclear';
}
