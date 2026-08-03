import { describe, it, expect, vi, beforeEach } from 'vitest';

// decision.ts pulls express + DB + messaging at load; mock those so we can reach
// notifyEmployeeDecision and control the SMS/email sends. EMAIL_ONLY:false so the
// SMS path is exercised (that's where the H2 fallback gap lived).
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false } }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ normalizeReSubject: vi.fn() }));
vi.mock('../../messaging/brand', () => ({ BRAND: {}, logoUrl: () => '' }));
vi.mock('../../workflows/shift-swap', () => ({ executeScheduleSwap: vi.fn(), executeScheduleTrade: vi.fn() }));
vi.mock('../../workflows/emergency-coverage', () => ({ processCoverageButtonDecision: vi.fn(), processCoverageBatchButton: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { notifyEmployeeDecision } from '../decision';
import { sendSms } from '../../messaging/sms';
import { sendEmail } from '../../messaging/email';

const mockSms = vi.mocked(sendSms);
const mockEmail = vi.mocked(sendEmail);
const base = { company_id: 'c1', smsChannel: '+16160000000', phone: '+16165551234', email: 'e@x.com', body: 'Approved!', subject: 'Decision' };

describe('notifyEmployeeDecision — email fallback (DRIFT_REGISTER H2)', () => {
  beforeEach(() => { mockSms.mockReset(); mockEmail.mockReset(); mockEmail.mockResolvedValue(true); });

  it('falls back to email when the SMS send fails (the H2 gap)', async () => {
    mockSms.mockResolvedValue(false);
    const ok = await notifyEmployeeDecision(base);
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
  });

  it('does NOT email when the SMS send succeeds', async () => {
    mockSms.mockResolvedValue(true);
    await notifyEmployeeDecision(base);
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it('emails directly when there is no phone (no SMS attempt)', async () => {
    await notifyEmployeeDecision({ ...base, phone: null });
    expect(mockSms).not.toHaveBeenCalled();
    expect(mockEmail).toHaveBeenCalledTimes(1);
  });

  it('returns false when SMS fails and there is no email to fall back to', async () => {
    mockSms.mockResolvedValue(false);
    const ok = await notifyEmployeeDecision({ ...base, email: null });
    expect(mockEmail).not.toHaveBeenCalled();
    expect(ok).toBe(false);
  });
});
