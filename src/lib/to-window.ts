import type { PartialDayDetail } from '../db/types';

// Per-employee per-date TO window info. `full_day` blocks the entire date;
// `partial` blocks only the listed time windows / shift IDs.
export interface TOWindow {
  type: 'full_day' | 'partial';
  blockedWindows: Array<{
    start: string; // HH:MM
    end: string;   // HH:MM
    shift_id?: string | null;
  }>;
}

type TORow = {
  employee_id: string;
  start_date: string;
  end_date: string;
  time_off_type: 'full_day' | 'partial' | null;
  partial_days: PartialDayDetail[] | null;
};

// Builds a 'employeeId:date' → TOWindow map from approved TO requests.
// Full-day TO overrides any partial TO on the same date; multiple partial
// entries on the same date merge their blocked windows.
export function buildTOMap(
  dates: string[],
  requests: ReadonlyArray<TORow>
): Map<string, TOWindow> {
  const map = new Map<string, TOWindow>();

  for (const tor of requests) {
    const isPartial =
      tor.time_off_type === 'partial' &&
      tor.partial_days != null &&
      tor.partial_days.length > 0;

    if (isPartial) {
      for (const detail of tor.partial_days!) {
        const key = `${tor.employee_id}:${detail.date}`;
        const existing = map.get(key);
        if (existing?.type === 'full_day') continue;
        const window = {
          start: (detail.start_time ?? '00:00').slice(0, 5),
          end: (detail.end_time ?? '23:59').slice(0, 5),
          shift_id: detail.shift_id ?? null,
        };
        if (existing?.type === 'partial') {
          existing.blockedWindows.push(window);
        } else {
          map.set(key, { type: 'partial', blockedWindows: [window] });
        }
      }
    } else {
      for (const date of dates) {
        if (date >= tor.start_date && date <= tor.end_date) {
          map.set(`${tor.employee_id}:${date}`, { type: 'full_day', blockedWindows: [] });
        }
      }
    }
  }

  return map;
}

// Returns true if the employee is blocked by approved TO for this shift.
// Full-day TO blocks everything. Partial TO blocks shifts that match a
// shift_id or overlap any blocked time window.
export function isBlockedByTO(
  employeeId: string,
  date: string,
  shiftStart: string,
  shiftEnd: string,
  shiftId: string,
  toMap: Map<string, TOWindow>
): boolean {
  const info = toMap.get(`${employeeId}:${date}`);
  if (!info) return false;
  if (info.type === 'full_day') return true;
  const ns = shiftStart.slice(0, 5);
  const ne = shiftEnd.slice(0, 5);
  return info.blockedWindows.some(w => {
    if (w.shift_id && w.shift_id === shiftId) return true;
    return ns < w.end && ne > w.start;
  });
}
