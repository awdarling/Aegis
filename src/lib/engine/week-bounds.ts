// Compute the bounds of a 7-day work week in local time. The configured
// week start day determines the anchor:
//
// - 'sunday' (default) — start at the most recent Sunday; end the following
//   Saturday. Sunday-Saturday weeks, backward-compatible with the previous
//   getSundayToSaturday behavior.
// - 'monday' — start at the most recent Monday; end the following Sunday.
//   On a Sunday, the "current" week is the one that just ended (6 days back),
//   not the one that starts the next morning.
//
// Using local-date arithmetic with the 'en-CA' locale formatter avoids the
// UTC drift that bit the previous engine — toISOString() rolls a Saturday
// evening forward to Sunday and shifts the entire week.
//
// offset:  0 → current week
//          1 → next week
//         -1 → previous week
export function getWeekBounds(
  offset: number = 0,
  weekStartDay: 'sunday' | 'monday' = 'sunday'
): { weekStart: string; weekEnd: string } {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun .. 6=Sat
  const daysSinceWeekStart = weekStartDay === 'monday'
    ? (dayOfWeek === 0 ? 6 : dayOfWeek - 1)
    : dayOfWeek;
  const start = new Date(today);
  start.setDate(today.getDate() - daysSinceWeekStart + offset * 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    weekStart: start.toLocaleDateString('en-CA'),
    weekEnd: end.toLocaleDateString('en-CA'),
  };
}
