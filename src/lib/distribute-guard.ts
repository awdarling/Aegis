// Re-distribution guard decision — the single source of truth for "should this
// schedule fan-out be blocked because it was already sent?". Kept as a tiny pure
// function in its own module (no DB/network/env deps) so it can be unit-checked
// in isolation, the same way src/messaging/greeting.ts is.
//
// distributed_at is the only reliable "already sent" signal: distributeScheduleCore
// writes it at the end of every successful fan-out. A non-null distributed_at means
// the ~30-person blast already went out, so re-triggering must be refused unless the
// caller explicitly forces a re-send (the future Homebase "Distribute" button).

export interface DistributableRow {
  distributed_at: string | null;
}

export function isAlreadyDistributed(row: DistributableRow, force: boolean): boolean {
  if (force) return false;
  return row.distributed_at != null;
}
