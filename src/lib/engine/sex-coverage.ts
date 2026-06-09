import type { Employee } from '../../db/types';
import type { ConcurrentCoverageConstraint } from '../constraints/types';
import type { ScheduleAssignment } from '../../workflows/schedule-build';
import type { FlaggedIssue, WeekState } from './types';

// Concurrent (facility-wide temporal) coverage evaluator. Validate-and-flag:
// returns FlaggedIssue[] without ever mutating weekState. Per date, segments
// the day at shift start/end boundaries from the population subset, walks each
// [t_i, t_{i+1}) block, and flags any required attribute value absent from the
// on-duty set. Single-staff blocks are skipped — the engine never schedules
// single-coverage windows among guard roles (single staffing is reserved for
// Greeter/Flex, which are excluded by population_roles), so a 1-person window
// among counted roles indicates a boundary artifact, not a real coverage gap.

function readAttr(emp: Employee, attribute: string): string {
  const rec = emp as unknown as Record<string, unknown>;
  const v = rec[attribute];
  if (v === null || v === undefined) return 'unknown';
  return String(v);
}

function hhmm(t: string): string {
  return t.slice(0, 5);
}

export interface OnDutyDetail {
  name: string;
  role: string;
  sex: string;
}

// Dedupe the union of on-duty people accumulated across coalesced segments
// (someone on duty across the whole gap would otherwise appear once per segment).
function dedupeOnDuty(rows: OnDutyDetail[]): OnDutyDetail[] {
  const seen = new Set<string>();
  const out: OnDutyDetail[] = [];
  for (const r of rows) {
    const key = `${r.name}|${r.role}|${r.sex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function evaluateSexCoverage(
  weekState: WeekState,
  constraint: ConcurrentCoverageConstraint,
  employeeById: Map<string, Employee>,
): FlaggedIssue[] {
  const flags: FlaggedIssue[] = [];
  const popRoles = new Set(constraint.population_roles);

  const byDate = new Map<string, ScheduleAssignment[]>();
  for (const a of weekState.assignments) {
    if (!popRoles.has(a.role)) continue;
    if (!byDate.has(a.date)) byDate.set(a.date, []);
    byDate.get(a.date)!.push(a);
  }

  const sortedDates = Array.from(byDate.keys()).sort();

  for (const date of sortedDates) {
    const dayAssigns = byDate.get(date)!;
    if (dayAssigns.length === 0) continue;

    const boundarySet = new Set<string>();
    for (const a of dayAssigns) {
      boundarySet.add(a.start_time);
      boundarySet.add(a.end_time);
    }
    const boundaries = Array.from(boundarySet).sort();

    // First pass: walk each boundary segment and record, per missing attribute
    // value, the [t0, t1) blocks where that value is absent from the on-duty set.
    type Seg = { start: string; end: string; onDuty: OnDutyDetail[] };
    const segmentsByValue = new Map<string, Seg[]>();

    for (let i = 0; i < boundaries.length - 1; i++) {
      const t0 = boundaries[i];
      const t1 = boundaries[i + 1];

      const onDuty = dayAssigns.filter(a => a.start_time <= t0 && a.end_time >= t1);
      if (onDuty.length < 2) continue;

      const presentValues = new Set<string>();
      for (const a of onDuty) {
        const emp = employeeById.get(a.employee_id);
        if (!emp) continue;
        presentValues.add(readAttr(emp, constraint.attribute));
      }

      const onDutyDetail: OnDutyDetail[] = onDuty.map(a => {
        const emp = employeeById.get(a.employee_id);
        return {
          name: emp?.name ?? a.employee_name,
          role: a.role,
          sex: emp ? readAttr(emp, constraint.attribute) : 'unknown',
        };
      });

      for (const [value, minN] of Object.entries(constraint.minimums)) {
        if (minN < 1) continue;
        if (presentValues.has(value)) continue;
        if (!segmentsByValue.has(value)) segmentsByValue.set(value, []);
        segmentsByValue.get(value)!.push({ start: t0, end: t1, onDuty: onDutyDetail });
      }
    }

    // Second pass: coalesce time-contiguous segments missing the SAME value into
    // a single flag, so one continuous coverage gap is one flag (not one per
    // boundary segment). A satisfied or single-staff segment between two missing
    // blocks breaks contiguity and keeps them as separate flags.
    for (const [value, segs] of segmentsByValue) {
      segs.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

      let run: Seg | null = null;
      const flush = () => {
        if (!run) return;
        flags.push({
          type: 'unsatisfied_sex_coverage',
          date,
          description: `No ${value} guard on duty ${hhmm(run.start)}–${hhmm(run.end)} on ${date}`,
          metadata: {
            time_window: { start: run.start, end: run.end },
            missing_sex: value,
            on_duty: dedupeOnDuty(run.onDuty),
          },
        });
        run = null;
      };

      for (const seg of segs) {
        if (run && run.end === seg.start) {
          run.end = seg.end;
          run.onDuty = run.onDuty.concat(seg.onDuty);
        } else {
          flush();
          run = { start: seg.start, end: seg.end, onDuty: seg.onDuty.slice() };
        }
      }
      flush();
    }
  }

  return flags;
}
