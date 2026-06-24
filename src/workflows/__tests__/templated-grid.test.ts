import { describe, it, expect } from 'vitest';
import { buildTemplatedScheduleGridHtml, type EmailScheduleTemplate } from '../templated-grid';
import type { ScheduleAssignment } from '../schedule-build';

const MON = '2026-05-04';
const TUE = '2026-05-05';

const asg = (over: Partial<ScheduleAssignment>): ScheduleAssignment => ({
  date: MON, employee_id: 'e1', employee_name: 'Ann', shift_name: 'Morning', role: 'Lifeguard',
  start_time: '09:00', end_time: '17:00', hours: 8, ...over,
});

const cols = [0, 1, 2, 3, 4, 5, 6].map(d => ({
  day: d, label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d], width: 160,
  color: d === 1 ? '#10b981' : '#888888', visible: true, order: d,
}));

function tmpl(layout_type: EmailScheduleTemplate['layout_type'], over: Partial<EmailScheduleTemplate> = {}): EmailScheduleTemplate {
  return {
    layout_type,
    column_config: cols,
    row_config: [{ id: 'Morning', label: 'Morning', visible: true, order: 0 }],
    display_options: { show_role: true, show_hours: false, show_start_end: false },
    ...over,
  };
}

const schedData = {
  assignments: [
    asg({ employee_id: 'e1', employee_name: 'Ann', shift_name: 'Morning', role: 'Lifeguard', date: MON }),
    asg({ employee_id: 'e2', employee_name: 'Bo', shift_name: 'Morning', role: 'Lifeguard', date: MON }),
    asg({ employee_id: 'e1', employee_name: 'Ann', shift_name: 'Evening', role: 'Headguard', date: TUE }),
  ],
  gaps: [],
};

describe('buildTemplatedScheduleGridHtml', () => {
  it('shifts layout: shift name as row header, people in cells', () => {
    const html = buildTemplatedScheduleGridHtml({ schedData, weekStart: MON, weekEnd: '2026-05-10', template: tmpl('shift-rows-day-columns') });
    expect(html).toContain('>Shift<');
    expect(html).toContain('Morning');
    expect(html).toContain('Ann');
    expect(html).toContain('Bo');
  });

  it('employee layout: people as row headers, shift names in cells', () => {
    const html = buildTemplatedScheduleGridHtml({ schedData, weekStart: MON, weekEnd: '2026-05-10', template: tmpl('employee-rows-day-columns') });
    expect(html).toContain('>Employee<');
    // Ann's row header + her Evening shift surfaced as cell content
    expect(html).toContain('Ann');
    expect(html).toContain('Evening');
  });

  it('role layout: roles as row headers', () => {
    const html = buildTemplatedScheduleGridHtml({ schedData, weekStart: MON, weekEnd: '2026-05-10', template: tmpl('role-rows-day-columns') });
    expect(html).toContain('>Role<');
    expect(html).toContain('Lifeguard');
    expect(html).toContain('Headguard');
  });

  it('applies the configured day color to the column header', () => {
    const html = buildTemplatedScheduleGridHtml({ schedData, weekStart: MON, weekEnd: '2026-05-10', template: tmpl('shift-rows-day-columns') });
    expect(html.toLowerCase()).toContain('background-color:#10b981');
  });

  it('honors show_role=false (no role text on the card)', () => {
    const html = buildTemplatedScheduleGridHtml({
      schedData, weekStart: MON, weekEnd: '2026-05-10',
      template: tmpl('shift-rows-day-columns', { display_options: { show_role: false } }),
    });
    // 'Lifeguard' would appear as a role span if shown; with show_role=false it shouldn't.
    expect(html).not.toContain('Lifeguard');
  });

  it('shows UNFILLED gaps in the shifts layout', () => {
    const html = buildTemplatedScheduleGridHtml({
      schedData: { assignments: [], gaps: [{ date: MON, shift_name: 'Morning', role: 'Lifeguard', required_count: 2, filled_count: 0, reason: '', description: '', per_employee_dispositions: [] }] },
      weekStart: MON, weekEnd: '2026-05-10', template: tmpl('shift-rows-day-columns'),
    });
    expect(html).toContain('UNFILLED');
  });

  it('marks a closed day in the header', () => {
    const html = buildTemplatedScheduleGridHtml({
      schedData: { assignments: schedData.assignments, gaps: [], closed_dates: [{ date: MON, event_title: 'Memorial Day' }] },
      weekStart: MON, weekEnd: '2026-05-10', template: tmpl('shift-rows-day-columns'),
    });
    expect(html).toContain('CLOSED');
    expect(html).toContain('Memorial Day');
  });

  it('empty schedule yields a plain message, not a table', () => {
    const html = buildTemplatedScheduleGridHtml({ schedData: { assignments: [], gaps: [] }, weekStart: MON, weekEnd: '2026-05-10', template: tmpl('employee-rows-day-columns') });
    expect(html).toContain('No shifts are on the schedule');
  });
});
