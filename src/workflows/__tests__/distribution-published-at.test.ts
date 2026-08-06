import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Batch-1 F3: Aegis distribution honors Homebase's published_at contract ──────
//
// Homebase's source of truth for "published" is the published_at TIMESTAMP
// (publish/route.ts + schedule/page.tsx), not the status enum. The Aegis/SMS
// distribute path used to set status='published' + distributed_at but leave
// published_at NULL, so a schedule distributed by text never showed as published
// in Homebase (F3a). It also emails AND texts phone-holders (F3b). This drives
// the REAL distributeScheduleCore and captures the schedules.update payloads.

const h = vi.hoisted(() => ({
  sendSmsMock: vi.fn(async () => true),
  sendEmailMock: vi.fn(async () => {}),
  scheduleUpdates: [] as Array<Record<string, unknown>>,
  scheduleRow: {
    id: 'sched-1', week_start: '2026-08-11', week_end: '2026-08-17',
    data: { assignments: [{ employee_id: 'e1', date: '2026-08-12', shift_name: 'Morning', role: 'Lifeguard', start_time: '09:00', end_time: '13:00', hours: 4 }] },
    status: 'draft', distributed_at: null, published_at: null,
  } as Record<string, unknown>,
}));

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local', EMAIL_ONLY: false,
  },
}));

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {
    select() { return builder; },
    update(payload: Record<string, unknown>) { if (table === 'schedules') h.scheduleUpdates.push(payload); return builder; },
    insert() { return Promise.resolve({ error: null }); },
    delete() { return builder; },
    eq() { return builder; },
    in() { return builder; },
    is() { return builder; },
    not() { return builder; },
    neq() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    single() {
      if (table === 'schedules') return Promise.resolve({ data: h.scheduleRow, error: null });
      if (table === 'companies') return Promise.resolve({ data: { name: 'Watermark' }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    maybeSingle() {
      if (table === 'company_channels') return Promise.resolve({ data: { channel_value: '+16166164898' }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    then(onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
      const data = table === 'employees'
        ? [{ id: 'e1', name: 'Luka', contact_email: 'luka@x.com', contact_phone: '+16167170847' }]
        : null;
      return Promise.resolve({ data, error: null }).then(onF, onR);
    },
  };
  return builder;
}

vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));
vi.mock('../../ai/claude', () => ({ generateReply: vi.fn(), classifyIntent: vi.fn(), withAnthropicRetry: vi.fn(), AnthropicOverloadError: class extends Error {} }));
vi.mock('../../messaging/email', () => ({ sendEmail: h.sendEmailMock }));
vi.mock('../../messaging/sms', () => ({ sendSms: h.sendSmsMock, getTenantSmsNumber: vi.fn(async () => '+16166164898') }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../special-notes', () => ({ getSpecialNotesForRange: vi.fn(async () => []) }));

import { distributeScheduleCore } from '../schedule-build';

beforeEach(() => { h.sendSmsMock.mockClear(); h.sendEmailMock.mockClear(); h.scheduleUpdates.length = 0; h.scheduleRow.published_at = null; h.scheduleRow.distributed_at = null; });

describe('distributeScheduleCore — published_at + SMS-first (Batch-1 F3)', () => {
  it('sets published_at (Homebase source of truth) on the distributed row', async () => {
    await distributeScheduleCore('sched-1', 'c1');
    const publishWrite = h.scheduleUpdates.find(u => u.status === 'published');
    expect(publishWrite).toBeTruthy();
    expect(publishWrite!.published_at).toBeTruthy();
    expect(publishWrite!.distributed_at).toBeTruthy();
  });

  it('emails AND texts a phone+email employee (F3b channel parity)', async () => {
    await distributeScheduleCore('sched-1', 'c1');
    expect(h.sendEmailMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock).toHaveBeenCalledTimes(1);
    expect(h.sendSmsMock.mock.calls[0][0]).toMatchObject({ to: '+16167170847' });
  });

  it('preserves an existing published_at on re-distribute (force)', async () => {
    h.scheduleRow.published_at = '2026-08-10T00:00:00.000Z';
    await distributeScheduleCore('sched-1', 'c1', true);
    const publishWrite = h.scheduleUpdates.find(u => u.status === 'published');
    expect(publishWrite!.published_at).toBe('2026-08-10T00:00:00.000Z');
  });
});
