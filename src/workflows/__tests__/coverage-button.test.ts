import { describe, it, expect } from 'vitest';
import { classifyCoverageButton, classifyCoverageBatchButton } from '../emergency-coverage';
import type { ActiveOutreach } from '../emergency-coverage';

function outreach(over: Partial<ActiveOutreach> = {}): ActiveOutreach {
  return {
    company_id: 'c1',
    employee_id: 'e1',
    shift_date: '2026-05-04',
    shift_info: { shift_name: 'Morning', start_time: '09:00', end_time: '17:00', role: 'Lifeguard' } as ActiveOutreach['shift_info'],
    callout_employee_name: 'Sam',
    callout_employee_id: 'e9',
    aegis_sms_channel: null,
    employee_phone: null,
    employee_channel: 'email',
    employee_email: 'e1@x.com',
    manager_contact: 'm@x.com',
    manager_channel: 'email',
    manager_sender: 'm@x.com',
    manager_recipient: 'aegis@x.com',
    manager_raw_subject: null,
    manager_thread_id: null,
    outreach_sent_at: new Date().toISOString(),
    window_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    coverage_filled: false,
    ...over,
  } as ActiveOutreach;
}

describe('classifyCoverageButton', () => {
  it('returns not_found when there is no active outreach', () => {
    expect(classifyCoverageButton(null, 'accept')).toBe('not_found');
    expect(classifyCoverageButton(null, 'decline')).toBe('not_found');
  });

  it('accept on an open outreach resolves to accept', () => {
    expect(classifyCoverageButton(outreach(), 'accept')).toBe('accept');
  });

  it('accept after the shift was already filled resolves to already_filled', () => {
    expect(classifyCoverageButton(outreach({ coverage_filled: true }), 'accept')).toBe('already_filled');
  });

  it('decline always resolves to decline (even if already filled)', () => {
    expect(classifyCoverageButton(outreach(), 'decline')).toBe('decline');
    expect(classifyCoverageButton(outreach({ coverage_filled: true }), 'decline')).toBe('decline');
  });
});

// #11 — the manager's "send another batch?" button outcome.
describe('classifyCoverageBatchButton', () => {
  const pool = [{ employee_id: 'a' }, { employee_id: 'b' }, { employee_id: 'c' }];

  it('no active session resolves to not_found', () => {
    expect(classifyCoverageBatchButton(null, 'send')).toBe('not_found');
    expect(classifyCoverageBatchButton(null, 'stop')).toBe('not_found');
  });

  it('stop always resolves to stopped', () => {
    expect(classifyCoverageBatchButton({ candidate_pool: pool, shown_count: 1 }, 'stop')).toBe('stopped');
  });

  it('send with more candidates left resolves to sent', () => {
    expect(classifyCoverageBatchButton({ candidate_pool: pool, shown_count: 1 }, 'send')).toBe('sent');
  });

  it('send with the pool already exhausted resolves to exhausted', () => {
    expect(classifyCoverageBatchButton({ candidate_pool: pool, shown_count: 3 }, 'send')).toBe('exhausted');
    expect(classifyCoverageBatchButton({ candidate_pool: [], shown_count: 0 }, 'send')).toBe('exhausted');
  });
});
