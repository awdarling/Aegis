import { describe, it, expect, vi } from 'vitest';

// schedule-build pulls in the Supabase client, messaging, and the Anthropic
// client at import. Mock those so we can reach the pure, employee-facing grid
// renderer without touching anything real.
vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test', BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test', SENDGRID_API_KEY: 'test', SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test', TWILIO_AUTH_TOKEN: 'test',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(), classifyIntent: vi.fn(), withAnthropicRetry: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn(), normalizeReSubject: (s: string) => s }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { buildFullScheduleGridHtml } from '../schedule-build';
import type { ScheduleAssignment } from '../schedule-build';
import { buildTemplatedScheduleGridHtml, type EmailScheduleTemplate } from '../templated-grid';

// INVARIANT: nothing employees receive may reveal who is a veteran, or that a
// shift has a veteran requirement. Veteran info is manager-only. This guards the
// all-staff grid embedded in every employee's distribution email so a future
// change can't quietly leak it.
describe('employee distribution grid reveals no veteran info', () => {
  // Two lifeguards on the same shift — imagine one is a veteran. The grid must
  // not betray that in any way.
  const assignments: ScheduleAssignment[] = [
    { date: '2026-06-27', employee_id: 'a', employee_name: 'Alex Stone', shift_name: 'PM', role: 'Lifeguard', start_time: '13:00:00', end_time: '21:00:00', hours: 8 },
    { date: '2026-06-27', employee_id: 'b', employee_name: 'Jamie Rivers', shift_name: 'PM', role: 'Lifeguard', start_time: '13:00:00', end_time: '21:00:00', hours: 8 },
  ];

  const html = buildFullScheduleGridHtml({
    schedData: { assignments, gaps: [] },
    weekStart: '2026-06-22',
    weekEnd: '2026-06-28',
  });

  it('still shows the people, shifts, and times', () => {
    expect(html).toContain('Alex Stone');
    expect(html).toContain('Jamie Rivers');
    expect(html).toContain('Lifeguard');
  });

  it('never emits veteran status or a veteran-rule tag', () => {
    expect(html).not.toMatch(/veteran/i);     // no "veteran" / "Veterans only"
    expect(html).not.toMatch(/\bVET\b/);       // no VET badge
    expect(html).not.toContain('≥');           // no "≥N veterans" requirement tag
  });
});

// Same invariant for the TEMPLATE-AWARE emailed schedule (templated-grid.ts),
// which now also rides in employee distribution emails when a club has set a
// schedule template. It must be just as clean across every layout.
describe('templated employee distribution grid reveals no veteran info', () => {
  const assignments: ScheduleAssignment[] = [
    { date: '2026-06-27', employee_id: 'a', employee_name: 'Alex Stone', shift_name: 'PM', role: 'Lifeguard', start_time: '13:00:00', end_time: '21:00:00', hours: 8 },
    { date: '2026-06-27', employee_id: 'b', employee_name: 'Jamie Rivers', shift_name: 'PM', role: 'Headguard', start_time: '13:00:00', end_time: '21:00:00', hours: 8 },
  ];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const tmpl = (layout: EmailScheduleTemplate['layout_type']): EmailScheduleTemplate => ({
    layout_type: layout,
    column_config: [0, 1, 2, 3, 4, 5, 6].map(d => ({ day: d, label: DAYS[d], color: '#888888', visible: true, order: d })),
    row_config: [{ id: 'PM', label: 'PM', visible: true, order: 0 }],
    display_options: { show_role: true, show_hours: true, show_start_end: false },
  });

  for (const layout of ['shift-rows-day-columns', 'employee-rows-day-columns', 'role-rows-day-columns'] as const) {
    const html = buildTemplatedScheduleGridHtml({ schedData: { assignments, gaps: [] }, weekStart: '2026-06-22', weekEnd: '2026-06-28', template: tmpl(layout) });

    it(`${layout}: still shows the people and shifts`, () => {
      expect(html).toMatch(/Alex Stone|PM|Lifeguard/);
    });

    it(`${layout}: never emits veteran status or a veteran-rule tag`, () => {
      expect(html).not.toMatch(/veteran/i);
      expect(html).not.toMatch(/\bVET\b/);
      expect(html).not.toContain('≥');
    });
  }
});
