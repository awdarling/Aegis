// TEMPLATE-EDIT-2 slice 6: the emailed schedule honors the manager's template.
//
// The legacy buildFullScheduleGridHtml (in schedule-build.ts) renders a fixed
// shifts×days grid with brand colors, ignoring the schedule_templates row. So
// the look a manager configures in Homebase (layout, day colors, column order,
// which fields show) never reached employees. This module renders the same
// email-safe inline <table>, but driven by the template — matching the
// on-screen grid + the download. It's used ONLY when a template row exists;
// otherwise the caller falls back to the legacy renderer, so current behavior
// is unchanged until a club configures a template.
//
// Self-contained on purpose (its own small date/format helpers, mirroring
// schedule-build.ts) so it stays unit-testable. Reuses the shared BRAND palette.

import { BRAND } from '../messaging/brand'
import type { ScheduleAssignment, ScheduleGap } from './schedule-build'

export interface EmailColumnConfig {
  day: number            // 0=Sun … 6=Sat
  label: string
  width?: number
  color?: string         // hex day color
  visible?: boolean
  order?: number
}
export interface EmailRowConfig {
  id: string             // shift name (for the shifts layout)
  label: string
  visible?: boolean
  order?: number
}
export interface EmailDisplayOptions {
  show_role?: boolean
  show_hours?: boolean
  show_start_end?: boolean
}
export interface EmailScheduleTemplate {
  layout_type: 'shift-rows-day-columns' | 'employee-rows-day-columns' | 'role-rows-day-columns'
  column_config: EmailColumnConfig[]
  row_config: EmailRowConfig[]
  display_options?: EmailDisplayOptions
}

interface ClosedDate { date: string; event_title?: string }
export interface TemplatedGridInput {
  schedData: { assignments?: ScheduleAssignment[]; gaps?: ScheduleGap[]; closed_dates?: ClosedDate[] }
  weekStart: string
  weekEnd: string
  template: EmailScheduleTemplate
}

// ── Small self-contained helpers (mirror schedule-build.ts exactly) ──────────
const esc = (s: string): string => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = []
  const cur = new Date(start + 'T12:00:00Z')
  const last = new Date(end + 'T12:00:00Z')
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return dates
}
const dowOf = (d: string): number => new Date(d + 'T12:00:00Z').getUTCDay()
const formatWeekday = (d: string): string => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' })
const formatShortDate = (d: string): string => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
function formatTime(t: string): string {
  const [h, m] = t.slice(0, 5).split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

// Readable text color over an arbitrary day color (luminance threshold).
function readableText(hex?: string): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return BRAND.silver
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#1a1a1a' : '#ffffff'
}

// ── Row models (mirror Homebase src/lib/schedule/layoutGrids.ts) ─────────────
interface GridRow { id: string; label: string; sub: string; cellsByDate: Map<string, ScheduleAssignment[]> }

function sortCell(list: ScheduleAssignment[]): ScheduleAssignment[] {
  return [...list].sort((a, b) =>
    (a.start_time || '').localeCompare(b.start_time || '') ||
    (a.shift_name || '').localeCompare(b.shift_name || '') ||
    (a.employee_name || '').localeCompare(b.employee_name || ''))
}

function employeeRows(assignments: ScheduleAssignment[]): GridRow[] {
  const map = new Map<string, GridRow>()
  for (const a of assignments) {
    if (!a.employee_id) continue
    let row = map.get(a.employee_id)
    if (!row) { row = { id: a.employee_id, label: a.employee_name || a.employee_id, sub: '', cellsByDate: new Map() }; map.set(a.employee_id, row) }
    const cell = row.cellsByDate.get(a.date) ?? []
    cell.push(a); row.cellsByDate.set(a.date, cell)
  }
  return Array.from(map.values()).sort((x, y) => x.label.localeCompare(y.label))
}
function roleRows(assignments: ScheduleAssignment[]): GridRow[] {
  const map = new Map<string, GridRow>()
  for (const a of assignments) {
    const role = (a.role || '').trim()
    if (!role) continue
    let row = map.get(role)
    if (!row) { row = { id: role, label: role, sub: '', cellsByDate: new Map() }; map.set(role, row) }
    const cell = row.cellsByDate.get(a.date) ?? []
    cell.push(a); row.cellsByDate.set(a.date, cell)
  }
  return Array.from(map.values()).sort((x, y) => x.label.localeCompare(y.label))
}

/** Build the team week grid as an email-safe inline <table>, driven by the template. */
export function buildTemplatedScheduleGridHtml(input: TemplatedGridInput): string {
  const { schedData, weekStart, weekEnd, template } = input
  const assignments = schedData.assignments ?? []
  const gaps = (schedData.gaps ?? []).filter(g => g.required_count > g.filled_count)
  const closedByDate = new Map((schedData.closed_dates ?? []).map(c => [c.date, c.event_title]))

  const allDates = getDatesInRange(weekStart, weekEnd)

  // Columns: template order + visibility + day color, mapped to this week's dates.
  const cfgCols = [...(template.column_config ?? [])]
    .filter(c => c.visible !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  let columns = cfgCols
    .map(cfg => ({ cfg, date: allDates.find(d => dowOf(d) === cfg.day) }))
    .filter((x): x is { cfg: EmailColumnConfig; date: string } => !!x.date)
  if (columns.length === 0) {
    columns = allDates.map(d => ({ cfg: { day: dowOf(d), label: formatWeekday(d) }, date: d }))
  }

  const opts = template.display_options ?? {}
  const showRole = opts.show_role !== false
  const showHours = opts.show_hours === true
  const showStartEnd = opts.show_start_end === true

  const meta = (a: ScheduleAssignment): string => {
    if (showStartEnd) return ` <span style="color:${BRAND.textSecondary};">${esc(formatTime(a.start_time))}–${esc(formatTime(a.end_time))}</span>`
    if (showHours) return ` <span style="color:${BRAND.textSecondary};">${a.hours}h</span>`
    return ''
  }

  // Build rows per layout.
  const layout = template.layout_type
  let rows: GridRow[]
  let rowHeaderLabel: string

  if (layout === 'employee-rows-day-columns') {
    rows = employeeRows(assignments)
    rowHeaderLabel = 'Employee'
  } else if (layout === 'role-rows-day-columns') {
    rows = roleRows(assignments)
    rowHeaderLabel = 'Role'
  } else {
    // shifts × days: template rows in order, plus any shift in the data that has
    // no template row (special-event shifts), so nothing is hidden from staff.
    const asgByShiftDate = new Map<string, ScheduleAssignment[]>()
    for (const a of assignments) {
      const k = `${a.shift_name}||${a.date}`
      ;(asgByShiftDate.get(k) ?? asgByShiftDate.set(k, []).get(k)!).push(a)
    }
    const startByShift = new Map<string, string>()
    for (const a of assignments) if (!startByShift.has(a.shift_name)) startByShift.set(a.shift_name, a.start_time)
    for (const g of gaps) if (!startByShift.has(g.shift_name)) startByShift.set(g.shift_name, g.start_time ?? '99:99')

    const tmplRows = [...(template.row_config ?? [])]
      .filter(r => r.visible !== false)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const known = new Set(tmplRows.map(r => r.id))
    const extraNames = Array.from(startByShift.keys()).filter(n => !known.has(n)).sort((x, y) =>
      (startByShift.get(x) ?? '99:99').localeCompare(startByShift.get(y) ?? '99:99'))

    const buildShiftRow = (id: string, label: string): GridRow => {
      const start = startByShift.get(id)
      const sub = start && start !== '99:99' ? formatTime(start) : ''
      const cells = new Map<string, ScheduleAssignment[]>()
      for (const d of columns.map(c => c.date)) cells.set(d, asgByShiftDate.get(`${id}||${d}`) ?? [])
      return { id, label, sub, cellsByDate: cells }
    }
    rows = [
      ...tmplRows.map(r => buildShiftRow(r.id, r.label)),
      ...extraNames.map(n => buildShiftRow(n, n)),
    ]
    rowHeaderLabel = 'Shift'
  }

  if (rows.length === 0) {
    return `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${BRAND.textSecondary};">No shifts are on the schedule for this week.</p>`
  }

  // gap lookup for the shifts layout (gaps are per-shift; alt layouts omit them)
  const gapByKey = new Map<string, ScheduleGap[]>()
  if (layout !== 'employee-rows-day-columns' && layout !== 'role-rows-day-columns') {
    for (const g of gaps) {
      const k = `${g.shift_name}||${g.date}`
      ;(gapByKey.get(k) ?? gapByKey.set(k, []).get(k)!).push(g)
    }
  }

  const headerCells = columns.map(({ cfg, date }) => {
    const bg = cfg.color || BRAND.surface3
    const fg = cfg.color ? readableText(cfg.color) : BRAND.silver
    const closure = closedByDate.get(date)
    const sub = closure
      ? `<div style="font-size:11px;color:${BRAND.badText};font-weight:bold;">CLOSED — ${esc(closure)}</div>`
      : `<div style="font-weight:normal;color:${cfg.color ? fg : BRAND.textSecondary};font-size:11px;">${esc(formatShortDate(date))}</div>`
    const w = cfg.width ? `width:${Math.round(cfg.width)}px;` : ''
    return `<th style="padding:8px 10px;border:1px solid ${BRAND.borderStrong};background-color:${bg};color:${fg};text-align:left;font-size:12px;font-weight:bold;${w}">${esc(cfg.label || formatWeekday(date))}${sub}</th>`
  }).join('')

  const bodyRows = rows.map(row => {
    const cells = columns.map(({ date }) => {
      if (closedByDate.has(date)) {
        return `<td style="padding:8px 10px;border:1px solid ${BRAND.borderDefault};background-color:${BRAND.bgBase};color:${BRAND.textMuted};font-size:12px;text-align:center;vertical-align:top;">—</td>`
      }
      const asgs = sortCell(row.cellsByDate.get(date) ?? [])
      const lines: string[] = []
      for (const a of asgs) {
        if (layout === 'employee-rows-day-columns') {
          // person is the row → headline the shift
          lines.push(`<div style="color:${BRAND.textPrimary};"><strong>${esc(a.shift_name)}</strong>${showRole ? ` <span style="color:${BRAND.textSecondary};">${esc(a.role)}</span>` : ''}${meta(a)}</div>`)
        } else if (layout === 'role-rows-day-columns') {
          // role is the row → headline the person
          lines.push(`<div style="color:${BRAND.textPrimary};"><strong>${esc(a.employee_name ?? '')}</strong>${meta(a)}</div>`)
        } else {
          lines.push(`<div style="color:${BRAND.textPrimary};"><strong>${esc(a.employee_name ?? '')}</strong>${showRole ? ` <span style="color:${BRAND.textSecondary};">${esc(a.role)}</span>` : ''}${meta(a)}</div>`)
        }
      }
      for (const g of (gapByKey.get(`${row.id}||${date}`) ?? [])) {
        const missing = g.required_count - g.filled_count
        for (let i = 0; i < missing; i++) {
          lines.push(`<div style="color:${BRAND.badText};font-weight:bold;">UNFILLED — ${esc(g.role)}</div>`)
        }
      }
      const inner = lines.length > 0 ? lines.join('') : `<span style="color:${BRAND.textMuted};">·</span>`
      return `<td style="padding:8px 10px;border:1px solid ${BRAND.borderDefault};background-color:${BRAND.surface2};font-size:12px;text-align:left;vertical-align:top;">${inner}</td>`
    }).join('')
    // row.sub (shift rows only) is already a formatted time string; render as-is.
    const subHtml = row.sub ? `<div style="font-weight:normal;color:${BRAND.textSecondary};font-size:11px;">${esc(row.sub)}</div>` : ''
    return `<tr><th style="padding:8px 10px;border:1px solid ${BRAND.borderStrong};background-color:${BRAND.surface3};color:${BRAND.textPrimary};text-align:left;font-size:12px;font-weight:bold;vertical-align:top;">${esc(row.label)}${subHtml}</th>${cells}</tr>`
  }).join('')

  return `<table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;">
<thead><tr><th style="padding:8px 10px;border:1px solid ${BRAND.borderStrong};background-color:${BRAND.surface3};color:${BRAND.silver};text-align:left;font-size:12px;font-weight:bold;">${esc(rowHeaderLabel)}</th>${headerCells}</tr></thead>
<tbody>${bodyRows}</tbody>
</table>`
}
