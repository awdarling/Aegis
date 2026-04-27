import { supabase } from '../db/client';

interface ActivityEntry {
  company_id: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(entry: ActivityEntry): Promise<void> {
  const { error } = await supabase.from('activity_log').insert({
    company_id: entry.company_id,
    actor: 'aegis',
    action: entry.action,
    entity_type: entry.entity_type ?? null,
    entity_id: entry.entity_id ?? null,
    summary: entry.summary,
    metadata: entry.metadata ?? null,
  });

  if (error) {
    console.error('[activity_log] failed to write:', error.message);
  }
}
