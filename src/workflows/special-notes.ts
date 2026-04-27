import { supabase } from '../db/client';
import type { Event } from '../db/types';

// Returns all events overlapping a target date for a given company.
// Called by every workflow before generating responses or schedules.
export async function getSpecialNotes(
  companyId: string,
  targetDate: string
): Promise<Event[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('company_id', companyId)
    .lte('date', targetDate)
    .gte('end_date', targetDate);

  if (error) {
    console.error('[special-notes] query error:', error.message);
    return [];
  }

  return data ?? [];
}

// Returns special notes for an entire date range (week), ordered by date.
export async function getSpecialNotesForRange(
  companyId: string,
  startDate: string,
  endDate: string
): Promise<Event[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('company_id', companyId)
    .lte('date', endDate)
    .gte('end_date', startDate)
    .order('date', { ascending: true });

  if (error) {
    console.error('[special-notes] range query error:', error.message);
    return [];
  }

  return data ?? [];
}

// Formats special notes into a human-readable block for Claude context injection.
export function formatSpecialNotes(events: Event[]): string {
  if (events.length === 0) return '';

  const lines = events.map((e) => {
    const dateRange = e.end_date && e.end_date !== e.date
      ? `${e.date} to ${e.end_date}`
      : (e.date ?? 'date unknown');
    const parts = [`[${e.event_type.toUpperCase()}] ${e.title} (${dateRange})`];
    if (e.description) parts.push(`  Note: ${e.description}`);
    if (e.staffing_notes) parts.push(`  Staffing: ${e.staffing_notes}`);
    return parts.join('\n');
  });

  return `SPECIAL NOTES / EVENTS:\n${lines.join('\n\n')}`;
}
