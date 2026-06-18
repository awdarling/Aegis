// Single source of truth for "what can Aegis do for you?" — drives BOTH the
// help / capabilities reply AND the out-of-scope redirect, so the two can never
// drift apart. Plain English, grouped by what the person is trying to get done.
//
// Roles map to Aegis contact roles: employee, manager, quria_admin. Managers can
// do everything an employee can, plus the manager actions; Quria admins get the
// manager set plus the Quria extras. The Soteria side (Homebase) mirrors this
// same list so Aegis and the in-app assistant say the same thing.

export type CapabilityRole = 'employee' | 'manager' | 'quria_admin';

// What anyone can ask Aegis for, about their own work life. Managers get these
// too — they're also employees of the club.
const EMPLOYEE_ACTIONS = [
  'Request time off, or check where a request stands',
  'Change your availability — including just until a date, or on a repeating schedule',
  'Ask about your own shifts',
  'Swap a shift with a coworker, or accept/decline a swap someone asks you about',
];

// Added for managers (and Quria admins), on top of the employee actions.
const MANAGER_ACTIONS = [
  'Build a schedule and send it out to the team',
  'Approve or deny time-off and availability requests',
  "Arrange emergency coverage when someone can't make a shift",
  'Ask about staffing and coverage — like "who\'s free Saturday?"',
  'Set staffing rules, like requiring veterans on a shift',
  'Add a new employee to the team',
];

// Quria-admin-only extras, on top of the manager actions.
const QURIA_ACTIONS = [
  'Send a broadcast message across companies',
];

// Short inline phrases for the out-of-scope redirect ("happy to help with X, Y,
// Z"). Kept terse on purpose — the full sentences above are too long for a list
// inside a sentence.
const EMPLOYEE_SHORT = ['time off', 'your availability', 'your shifts', 'shift swaps'];

function firstNameOf(name?: string | null): string {
  const n = (name ?? '').trim().split(/\s+/)[0];
  return n || '';
}

// Join a list into a natural "a, b, and c" phrase.
function naturalList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// The role-aware capability groups, used to render the help reply.
export function capabilityGroups(
  role: CapabilityRole
): { heading: string; items: string[] }[] {
  const isManager = role === 'manager' || role === 'quria_admin';
  const groups: { heading: string; items: string[] }[] = [
    { heading: isManager ? 'For your own schedule' : 'Here to help with', items: EMPLOYEE_ACTIONS },
  ];
  if (isManager) groups.push({ heading: 'As a manager', items: MANAGER_ACTIONS });
  if (role === 'quria_admin') groups.push({ heading: 'Quria admin', items: QURIA_ACTIONS });
  return groups;
}

// Full "what can you do for me?" reply, warm and role-aware.
export function buildCapabilitiesReply(role: CapabilityRole, name?: string | null): string {
  const first = firstNameOf(name);
  const hi = first ? `Hey ${first} — ` : 'Hey — ';
  const groups = capabilityGroups(role);

  const blocks = groups.map((g) => {
    const lines = g.items.map((i) => `• ${i}`).join('\n');
    return `${g.heading}:\n${lines}`;
  });

  const intro =
    role === 'employee'
      ? `${hi}here's what I can help you with:`
      : `${hi}here's what I can do for you:`;

  return `${intro}\n\n${blocks.join('\n\n')}\n\nJust tell me in your own words and I'll take care of it.`;
}

// Short sentence naming what the person CAN ask for — used by the out-of-scope
// redirect so a "no" never dead-ends. Employees get the employee actions.
export function allowedActionsLine(role: CapabilityRole): string {
  // Managers/Quria rarely hit the redirect (they can do almost everything), but
  // if they do, point them at the same plain list.
  const items = role === 'employee' ? EMPLOYEE_SHORT : EMPLOYEE_SHORT;
  return naturalList(items);
}
