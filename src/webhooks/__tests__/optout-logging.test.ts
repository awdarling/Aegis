import { describe, it, expect, vi, beforeEach } from 'vitest';

// A STOP after onboarding must leave a visible, timestamped record so a manager
// can see who opted out (and why they've stopped getting texts) — not just a
// console line. START logs the mirror resubscribe event. Best-effort: resolves
// the employee from the tenant number + sender phone.

const h = vi.hoisted(() => ({
  companyId: 'co-1' as string | null,
  employee: { id: 'e1', name: 'Luka Darling' } as { id: string; name: string } | null,
  logMock: vi.fn(async () => {}),
}));

vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: false } }));
vi.mock('../../middleware/verify-signature', () => ({ verifyTelnyxRequest: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../../security/sender-verification', () => ({
  verifySender: vi.fn(),
  resolveCompanyId: vi.fn(async () => h.companyId),
}));
vi.mock('../../router/intent-router', () => ({ routeIntent: vi.fn() }));
vi.mock('../../logger/conversation', () => ({ saveConversation: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: (...a: unknown[]) => h.logMock(...a) }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b;
      b.maybeSingle = async () => ({ data: h.employee, error: null });
      return b;
    },
  },
}));

import { recordCarrierKeywordEvent } from '../sms';
import type { InboundMessage } from '../../security/types';

const msg = (body: string): InboundMessage => ({ sender: '+16167170847', recipient: '+16166164898', body, channel: 'sms' });

beforeEach(() => { h.logMock.mockClear(); h.companyId = 'co-1'; h.employee = { id: 'e1', name: 'Luka Darling' }; });

describe('recordCarrierKeywordEvent', () => {
  it('logs employee_opted_out for a STOP from a known employee, with the keyword + who', async () => {
    await recordCarrierKeywordEvent(msg('STOP'), 'opted_out');
    expect(h.logMock).toHaveBeenCalledTimes(1);
    const entry = h.logMock.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.action).toBe('employee_opted_out');
    expect(entry.company_id).toBe('co-1');
    expect(entry.entity_id).toBe('e1');
    expect(String(entry.summary)).toMatch(/Luka Darling opted out of SMS \(texted STOP\)/);
    expect((entry.metadata as Record<string, unknown>).opted_out_at).toBeTruthy();
  });

  it('logs employee_resubscribed for a START', async () => {
    await recordCarrierKeywordEvent(msg('START'), 'resubscribed');
    const entry = h.logMock.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.action).toBe('employee_resubscribed');
    expect((entry.metadata as Record<string, unknown>).resubscribed_at).toBeTruthy();
  });

  it('still logs a company-scoped event when the number is not a known employee', async () => {
    h.employee = null;
    await recordCarrierKeywordEvent(msg('CANCEL'), 'opted_out');
    const entry = h.logMock.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.action).toBe('employee_opted_out');
    expect(entry.entity_id).toBeUndefined();
    expect(String(entry.summary)).toMatch(/unrecognized number/i);
  });

  it('no-ops (no log) when the destination number maps to no tenant', async () => {
    h.companyId = null;
    await recordCarrierKeywordEvent(msg('STOP'), 'opted_out');
    expect(h.logMock).not.toHaveBeenCalled();
  });
});
