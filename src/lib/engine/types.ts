import type { Employee } from '../../db/types';
import type { ScheduleAssignment, ScheduleGap, FlaggedIssue } from '../../workflows/schedule-build';

// A single fillable position in the week — one CanvasSlot per required head
// per shift_requirement per date. Generated up front and then visited in
// fill order.
export interface CanvasSlot {
  date: string;
  shift_type_id: string;
  shift_name: string;
  shift_requirement_id: string;
  /** The PREFERRED role for this slot. Drives ranking (primary-role fit) and all
   *  manager-facing copy ("Lifeguard slot unfilled"). Always the first entry of
   *  accepted_roles. */
  role: string;
  /**
   * D10 — EVERY role that may fill this slot. The manager sets this in the shift
   * box ("Lifeguard or Headguard"); Watermark's Flex shift uses it today.
   *
   * The engine used to match on `role` ALONE, so a Headguard could never fill a
   * "Lifeguard or Headguard" slot — the build reported a GAP while a qualified
   * person sat available. The manager's stated intent was silently discarded.
   *
   * Eligibility now accepts an employee qualified for ANY of these. Ranking still
   * PREFERS `role`, so behaviour is unchanged when there's only one accepted role
   * (which is every other Watermark requirement).
   */
  accepted_roles: string[];
  start_time: string;
  end_time: string;
  hours: number;
  required_count: number;
  slot_index: number;
  is_priority: boolean;
}

// The remaining-after-hard-filters pool for a single slot, with removal
// reasons retained for gap-reason reporting.
export interface CandidatePool {
  employees: Employee[];
  removed_reasons: Map<string, string>;
}

// Engine mutable state for one week build. `assignments` is the source of
// truth for "who's working what" — same-day / overlap checks read it via
// sameDayDoubleReason in eligibility.ts. Don't reintroduce a parallel index.
export interface WeekState {
  weeklyHoursMap: Map<string, number>;
  assignments: ScheduleAssignment[];
  gaps: ScheduleGap[];
  flagged_issues: FlaggedIssue[];
}

export type { FlaggedIssue };
