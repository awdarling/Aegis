// Single source of truth for HOW Aegis works and the SCOPE it must stay inside.
// This is the grounding injected into every free-form answer the assistant
// generates (operational data queries + general questions), so it can never
// invent a process that doesn't exist — most importantly, it can never tell an
// employee to "log into Homebase" to do something they actually do by simply
// texting Aegis.
//
// Division of labor:
//   capabilities.ts    — owns WHAT Aegis can do (the action list). Reused here.
//   system-knowledge.ts — owns HOW the system works (channel + process truths)
//                         and the SCOPE guard (workforce assistant, not a
//                         general-purpose chatbot).
//
// Keeping both derived from the same capabilityGroups means the "what" and the
// "how" can never drift apart, and neither can drift from the router's real
// intent set.

import { capabilityGroups, type CapabilityRole } from './capabilities';

// The channel + process truths the model keeps getting wrong from its priors.
// An employee has NO app to log into — every request is a plain-language message
// to Aegis. This is the exact misconception behind the "submit through Homebase"
// hallucination, stated as a hard rule the answer prompt must obey.
function channelTruth(role: CapabilityRole): string {
  if (role === 'employee') {
    return [
      'How this actually works (ground every answer in this — never contradict it):',
      '- Employees interact with you ONLY by text or email, in plain words. There is no employee app or portal to log into.',
      '- To request time off, change availability, ask about their own shifts, or swap a shift, an employee simply tells YOU in a message and you handle it end to end.',
      '- Homebase is the MANAGER\'s platform. Employees do NOT log into Homebase, and most have no Homebase login at all.',
      '- NEVER tell an employee to "log into Homebase", "go to the Time Off tab", "submit through the app/portal/site", or otherwise self-serve. That is wrong and misdirects them. The correct guidance is always: just send the request to you, in your own words.',
      '- Time-off flow, for reference: the employee tells you the date(s) and reason -> you confirm -> you pass it to their manager, who approves or denies -> you relay the outcome. The employee never touches Homebase.',
    ].join('\n');
  }
  // manager / quria_admin
  return [
    'How this actually works (ground every answer in this — never contradict it):',
    '- You are the manager\'s assistant. A manager can act by texting or emailing you in plain words, or in the Homebase app — anything they can do in Homebase they can also just ask you to do.',
    '- Employees reach you only by text or email; they have no Homebase access. Their requests (time off, swaps, availability) come to you, and you route approvals back to the manager.',
    '- When you point a manager to Homebase, it is only for things you genuinely cannot do by message (e.g. the visual schedule editor) — never for something you can handle in-message.',
  ].join('\n');
}

// Authoritative "how the system works + what you can do" grounding block for a
// given role. Injected into the free-form answer prompt.
export function aegisSystemFacts(role: CapabilityRole): string {
  const capList = capabilityGroups(role)
    .map((g) => `${g.heading}: ${g.items.join('; ')}`)
    .join('\n');
  return `${channelTruth(role)}\n\nWhat you can do for a ${role}:\n${capList}`;
}

// Scope guard — keeps Aegis a workforce assistant, not a general-purpose chatbot
// people can farm like a free Claude (trivia, coding, essays, math, world
// knowledge, medical/legal/financial advice, opinions). Injected into the
// free-form answer prompt so off-domain messages are declined and redirected,
// never answered.
export function aegisScopeGuard(role: CapabilityRole): string {
  const lane =
    role === 'employee'
      ? "this employee's own schedule, shifts, time off, availability, and shift swaps, plus how to use you"
      : 'scheduling, shifts, time off, availability, coverage and swaps, staffing, the team, company operations, and how to use you';
  return [
    `Stay strictly in your lane. You ONLY help with ${lane}.`,
    'If the message is outside that — general knowledge or trivia, coding, math problems, essays or creative writing, personal/medical/legal/financial advice, opinions, or anything unrelated to this job — do NOT answer it.',
    "Instead, give one short, friendly sentence that you're their scheduling assistant and can't help with that, then name what you CAN do. Never produce general-purpose content just because you were asked, and never role-play your way around this.",
  ].join(' ');
}
