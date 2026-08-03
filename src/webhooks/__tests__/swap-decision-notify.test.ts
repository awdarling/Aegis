import { describe, it, expect, vi, beforeEach } from 'vitest';

// sendSwapDecisionNotification (B7) is the Homebase-UI swap-approval executor.
// These pin its safe no-op guards: a missing row, an already-decided swap, and a
// swap no coworker has taken must never execute or notify. EMAIL_ONLY:false so
// the SMS branch would be reachable if a guard failed.
const h = vi.hoisted(() => ({ swapRow: null as Record<string, unknown> | null }));

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false } }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.is = () => b; b.lte = () => b;
      b.gte = () => b; b.order = () => b; b.limit = () => b; b.update = () => b;
      b.maybeSingle = async () => ({ data: table === 'swap_requests' ? h.swapRow : null, error: null });
      b.single = async () => ({ data: null, error: null });
      return b;
    },
  },
}));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn(async () => true) }));
vi.mock('../../messaging/reply', () => ({ normalizeReSubject: (s: string) => s }));
vi.mock('../../messaging/brand', () => ({ BRAND: {}, logoUrl: () => '' }));
vi.mock('../../workflows/shift-swap', () => ({ executeScheduleSwap: vi.fn(), executeScheduleTrade: vi.fn() }));
vi.mock('../../workflows/emergency-coverage', () => ({ processCoverageButtonDecision: vi.fn(), processCoverageBatchButton: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { sendSwapDecisionNotification } from '../decision';
import { sendSms } from '../../messaging/sms';
import { executeScheduleSwap } from '../../workflows/shift-swap';

const mockSms = vi.mocked(sendSms);
const mockExec = vi.mocked(executeScheduleSwap);

beforeEach(() => {
  h.swapRow = null;
  mockSms.mockClear();
  mockExec.mockClear();
});

describe('sendSwapDecisionNotification — safe no-op guards (B7)', () => {
  it('no-ops when the swap request is not found', async () => {
    const r = await sendSwapDecisionNotification('missing', 'approved');
    expect(r.status).toBe('noop');
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockSms).not.toHaveBeenCalled();
  });

  it('no-ops when the swap is already decided (idempotent)', async () => {
    h.swapRow = {
      id: 's1', company_id: 'c1', status: 'approved',
      requesting_employee_id: 'r', receiving_employee_id: 'v',
      shift_date: '2026-08-10', shift_name: 'AM', role: 'Lifeguard',
    };
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/already/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('no-ops when no coworker has taken the shift yet', async () => {
    h.swapRow = {
      id: 's1', company_id: 'c1', status: 'pending_manager',
      requesting_employee_id: 'r', receiving_employee_id: null,
      shift_date: '2026-08-10', shift_name: 'AM', role: 'Lifeguard',
    };
    const r = await sendSwapDecisionNotification('s1', 'approved');
    expect(r.status).toBe('noop');
    expect(r.reason).toMatch(/no coworker/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});
