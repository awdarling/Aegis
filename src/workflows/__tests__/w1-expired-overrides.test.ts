import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── W-1 / C-1 + J-2: expired availability overrides are not "in force" ─────────
//
// Named after the transcripts they fix (Competition + Jack audits, 2026-08-26):
//   • Jenna Stibitz, Aug 22 — "for Aug 24–Aug 30, I can only work sunday" with an
//     active override that ended 2026-07-16. She was asked "normal or temporary
//     (through Thursday, July 16)?" six times and her own dates were replaced by
//     the dead override's end date. Expected: no question; a temporary change
//     through 2026-08-30, Sunday only.
//   • Jenna, same day — "for the rest of the season i can only work sundays" →
//     a normal (permanent) change, no question.
//   • Katie Schillaci — "going forward I can only work Friday mornings" with an
//     override that ended 2026-06-05 → normal, no question.
//   • Katie — "what's my availability?" with that expired override → the
//     "Normal:" block only; no "Temporary override … takes priority right now".
//   • Mya Vanderzwaag, Aug 14 — an expired override must never be offered.
//   • A CURRENT override + a message that doesn't say which → the question IS
//     asked, phrased as a natural question (no 'Just say "normal" or "temporary"').

const TODAY = '2026-08-22';

const h = vi.hoisted(() => ({
  replyMock: vi.fn(async () => {}),
  memoryInserts: [] as Array<Record<string, unknown>>,
  recorded: [] as Array<{ table: string; op: string; rows?: unknown; filters: Record<string, unknown> }>,
  normalRows: [{ day_of_week: 1, start_time: '09:00', end_time: '17:00' }] as Array<Record<string, unknown>>,
  overrideRows: [] as Array<Record<string, unknown>>,
  llmText: '',
  createMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: h.createMock };
  },
}));
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false, ANTHROPIC_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', SENDGRID_FROM_EMAIL: 'a@b.c', BASE_URL: 'http://x' } }));

function makeBuilder(table: string) {
  const state: { op: string; rows?: unknown; filters: Record<string, unknown> } = { op: 'select', filters: {} };
  const term = () => {
    h.recorded.push({ table, op: state.op, rows: state.rows, filters: state.filters });
    let data: unknown = null;
    if (state.op === 'select') {
      if (table === 'availability') data = h.normalRows;
      else if (table === 'custom_availability') data = h.overrideRows.filter(r => r.active !== false);
      else if (table === 'shift_types') data = [{ start_time: '09:00', end_time: '20:15' }];
      else if (table === 'companies') data = { timezone: 'America/Detroit' };
      else data = [];
    } else if (state.op === 'update' && table === 'custom_availability') {
      data = h.overrideRows.filter(r => r.active !== false && typeof r.end_date === 'string' && (r.end_date as string) < (state.filters['lt:end_date'] as string)).map(r => ({ id: r.id }));
    }
    return Promise.resolve({ data, error: null });
  };
  const builder: Record<string, unknown> = {
    select() { return builder; },
    eq(col: string, val: unknown) { state.filters[col] = val; return builder; },
    in() { return builder; },
    is() { return builder; },
    not(col: string, _op: string, val: unknown) { state.filters[`not:${col}`] = val; return builder; },
    lt(col: string, val: unknown) { state.filters[`lt:${col}`] = val; return builder; },
    limit() { return builder; },
    delete() { state.op = 'delete'; return builder; },
    update(rows: unknown) { state.op = 'update'; state.rows = rows; return builder; },
    insert(vals: Record<string, unknown>) {
      state.op = 'insert';
      if (table === 'aegis_memory') h.memoryInserts.push(vals);
      return Promise.resolve({ error: null });
    },
    maybeSingle() { return term(); },
    single() { return term(); },
    then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
      return term().then(onF, onR);
    },
  };
  return builder;
}

vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));
vi.mock('../../messaging/reply', () => ({ reply: h.replyMock, sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => true) }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../ai/claude', () => ({ withAnthropicRetry: (fn: () => unknown) => fn() }));
vi.mock('../../lib/tenant-date', () => ({ tenantToday: vi.fn(async () => TODAY), todayInTimezone: () => TODAY }));

import { isOverrideCurrent, pickCurrentOverride } from '../../lib/custom-availability';
import {
  handleUpdateAvailability,
  handleMyAvailabilityQuery,
  readAvailTargetFromMessage,
  classifyAvailTarget,
} from '../employee-onboarding';
import { retireExpiredOverrides } from '../../scheduler/employee-offboarding';

const contact = { role: 'employee', company_id: 'c1', employee_id: 'e1', user_id: null, name: 'Jenna Stibitz', matched_identifier: '+16163280114', channel: 'sms' } as never;
const msg = (body: string) => ({ sender: '+16163280114', recipient: '+16166164898', body, channel: 'sms' }) as never;

const EXPIRED_JULY = { id: 'ov-july', type: 'date_limited', active: true, end_date: '2026-07-16', effective_start_date: null, cycle_weeks: null, patterns: [{ day_of_week: 0, start_time: '09:00', end_time: '20:15' }] };
const EXPIRED_JUNE = { id: 'ov-june', type: 'date_limited', active: true, end_date: '2026-06-05', effective_start_date: null, cycle_weeks: null, patterns: [{ day_of_week: 5, start_time: '09:00', end_time: '12:00' }] };
const CURRENT_SEPT = { id: 'ov-sept', type: 'date_limited', active: true, end_date: '2026-09-07', effective_start_date: null, cycle_weeks: null, patterns: [{ day_of_week: 6, start_time: '09:00', end_time: '15:30' }] };

function replies(): string[] {
  return h.replyMock.mock.calls.map(c => c[2] as string);
}
function askedWhich(): boolean {
  return replies().some(b => /temporary stretch|normal availability, or your temporary/i.test(b));
}
function pendingConfirm(): Record<string, unknown> | null {
  const row = h.memoryInserts.find(m => (m.source as string) === 'avail_pending_confirm:e1');
  return row ? (JSON.parse(row.content as string) as Record<string, unknown>) : null;
}
function llmSaysExclusive(slots: Array<{ day_of_week: number; start_time: string; end_time: string }>) {
  h.createMock.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ mode: 'set', scope: 'exclusive', slots }) }] });
}

beforeEach(() => {
  h.replyMock.mockClear();
  h.createMock.mockReset();
  h.memoryInserts.length = 0;
  h.recorded.length = 0;
  h.normalRows = [{ day_of_week: 1, start_time: '09:00', end_time: '17:00' }, { day_of_week: 3, start_time: '09:00', end_time: '17:00' }];
  h.overrideRows = [];
});

describe('isOverrideCurrent — one answer to "is this override in force?"', () => {
  it('an active row that ended before today is NOT current', () => {
    expect(isOverrideCurrent({ active: true, end_date: '2026-07-16' }, TODAY)).toBe(false);
  });
  it('an active row ending today or later IS current', () => {
    expect(isOverrideCurrent({ active: true, end_date: TODAY }, TODAY)).toBe(true);
    expect(isOverrideCurrent({ active: true, end_date: '2026-09-07' }, TODAY)).toBe(true);
  });
  it('an open-ended active row (no end_date) is current; an inactive one never is', () => {
    expect(isOverrideCurrent({ active: true, end_date: null }, TODAY)).toBe(true);
    expect(isOverrideCurrent({ active: false, end_date: null }, TODAY)).toBe(false);
    expect(isOverrideCurrent(null, TODAY)).toBe(false);
  });
  it('pickCurrentOverride skips the expired rows and returns the first live one', () => {
    expect(pickCurrentOverride([EXPIRED_JULY, CURRENT_SEPT], TODAY)?.id).toBe('ov-sept');
    expect(pickCurrentOverride([EXPIRED_JULY, EXPIRED_JUNE], TODAY)).toBeNull();
  });
});

describe('readAvailTargetFromMessage — the message\'s own words decide', () => {
  it('Jenna: "for Aug 24–Aug 30, I can only work sunday" (classifier gave end_date) → temporary', () => {
    expect(readAvailTargetFromMessage('for Aug 24–Aug 30, I can only work sunday', { end_date: '2026-08-30' })).toBe('temporary');
  });
  it('Jenna: "for the rest of the season i can only work sundays" → normal', () => {
    expect(readAvailTargetFromMessage('for the rest of the season i can only work sundays', {})).toBe('normal');
  });
  it('Katie: "going forward I can only work Friday mornings" → normal', () => {
    expect(readAvailTargetFromMessage('going forward I can only work Friday mornings', {})).toBe('normal');
  });
  it('Maisey: "going forward i can only work evenings" → normal', () => {
    expect(readAvailTargetFromMessage('going forward i can only work evenings', {})).toBe('normal');
  });
  it('a bare change with no time signal is genuinely ambiguous → null (caller may ask)', () => {
    expect(readAvailTargetFromMessage('I can only work Saturdays', {})).toBeNull();
  });
  it('an explicit end_date beats permanence words', () => {
    expect(readAvailTargetFromMessage('going forward until Sept 7 I can only work weekends', { end_date: '2026-09-07' })).toBe('temporary');
  });
  it('the natural answers to the new question still classify', () => {
    expect(classifyAvailTarget('just for that temporary stretch')).toBe('temporary');
    expect(classifyAvailTarget('my normal week going forward')).toBe('normal');
    expect(classifyAvailTarget('for now')).toBe('temporary');
  });
});

describe('Jenna Stibitz, Aug 22 — expired July override must not hijack her change', () => {
  it('"for Aug 24–Aug 30, I can only work sunday" → no question; temporary through 2026-08-30, Sunday only', async () => {
    h.overrideRows = [EXPIRED_JULY];
    llmSaysExclusive([{ day_of_week: 0, start_time: '09:00', end_time: '20:15' }]);
    await handleUpdateAvailability(msg('for Aug 24–Aug 30, I can only work sunday'), contact, { end_date: '2026-08-30' });
    expect(askedWhich()).toBe(false);
    expect(h.memoryInserts.some(m => (m.source as string).startsWith('avail_target_disambig:'))).toBe(false);
    const pending = pendingConfirm();
    expect(pending).not.toBeNull();
    expect(pending!.custom_end_date).toBe('2026-08-30');            // HER date, not July 16
    const proposed = pending!.proposed_availability as Array<{ day_of_week: number }>;
    expect(proposed.map(s => s.day_of_week)).toEqual([0]);            // Sunday only
    expect(replies().join('\n')).not.toMatch(/July 16/);
    expect(replies().join('\n')).toMatch(/August 30/);
  });

  it('"for the rest of the season i can only work sundays" → no question; a NORMAL change', async () => {
    h.overrideRows = [EXPIRED_JULY];
    llmSaysExclusive([{ day_of_week: 0, start_time: '09:00', end_time: '20:15' }]);
    await handleUpdateAvailability(msg('for the rest of the season i can only work sundays'), contact, {});
    expect(askedWhich()).toBe(false);
    const pending = pendingConfirm();
    expect(pending).not.toBeNull();
    expect(pending!.custom_end_date).toBeNull();
    expect(replies().join('\n')).not.toMatch(/July 16/);
  });
});

describe('Katie Schillaci — "going forward I can only work Friday mornings" with an override that ended June 5', () => {
  it('→ normal change, no question, June 5 never mentioned', async () => {
    h.overrideRows = [EXPIRED_JUNE];
    llmSaysExclusive([{ day_of_week: 5, start_time: '09:00', end_time: '12:00' }]);
    await handleUpdateAvailability(msg('going forward I can only work Friday mornings'), contact, {});
    expect(askedWhich()).toBe(false);
    expect(pendingConfirm()?.custom_end_date).toBeNull();
    expect(replies().join('\n')).not.toMatch(/June 5/);
  });

  it('"what\'s my availability?" with the expired override → "Normal:" block only', async () => {
    h.overrideRows = [EXPIRED_JUNE];
    await handleMyAvailabilityQuery(msg("what's my availability?"), contact, {});
    const body = replies()[0];
    expect(body).toMatch(/here's your availability/i);
    expect(body).not.toMatch(/Temporary override/i);
    expect(body).not.toMatch(/takes priority right now/i);
    expect(body).not.toMatch(/June 5/);
  });

  it('a CURRENT override still shows in the query, with its real end date', async () => {
    h.overrideRows = [EXPIRED_JUNE, CURRENT_SEPT];
    await handleMyAvailabilityQuery(msg("what's my availability?"), contact, {});
    const body = replies()[0];
    expect(body).toMatch(/Normal:/);
    expect(body).toMatch(/Temporary override/i);
    expect(body).toMatch(/September 7/);
    expect(body).not.toMatch(/June 5/);
  });
});

describe('Mya Vanderzwaag, Aug 14 — an ambiguous change with ONLY an expired override on file', () => {
  it('is treated as a plain change (no "(through Saturday, June 6)" question)', async () => {
    h.overrideRows = [{ ...EXPIRED_JUNE, end_date: '2026-06-06' }];
    llmSaysExclusive([{ day_of_week: 4, start_time: '09:00', end_time: '20:15' }]);
    await handleUpdateAvailability(msg('I am able to work that day now'), contact, {});
    expect(askedWhich()).toBe(false);
    expect(replies().join('\n')).not.toMatch(/June 6/);
  });
});

describe('a genuinely ambiguous change against a CURRENT override still asks — naturally', () => {
  it('asks once, names the real end date, and never says \'Just say "normal" or "temporary"\'', async () => {
    h.overrideRows = [CURRENT_SEPT];
    await handleUpdateAvailability(msg('I can only work Saturdays'), contact, {});
    expect(askedWhich()).toBe(true);
    const body = replies()[0];
    expect(body).toMatch(/September 7/);
    expect(body).not.toMatch(/just say/i);
    expect(body).not.toMatch(/"normal" or "temporary"/i);
    expect(body).toMatch(/\?$/);
    expect(h.memoryInserts.some(m => (m.source as string).startsWith('avail_target_disambig:'))).toBe(true);
  });
});

describe('retireExpiredOverrides — the daily broom', () => {
  it('switches off only rows whose end_date is at least two days in the past', async () => {
    h.overrideRows = [EXPIRED_JULY, CURRENT_SEPT];
    const n = await retireExpiredOverrides();
    const upd = h.recorded.find(r => r.table === 'custom_availability' && r.op === 'update');
    expect(upd).toBeDefined();
    expect((upd!.rows as { active: boolean }).active).toBe(false);
    expect(upd!.filters.active).toBe(true);
    expect(typeof upd!.filters['lt:end_date']).toBe('string');
    // Cutoff is two days behind the real clock (not TODAY — the sweep is server-side).
    const cutoff = upd!.filters['lt:end_date'] as string;
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    expect(cutoff).toBe(twoDaysAgo);
    expect(n).toBe(1);
  });
});
