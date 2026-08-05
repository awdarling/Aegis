import { supabase } from '../db/client';

interface ActivityEntry {
  company_id: string;
  actor?: 'aegis' | 'quria_admin' | 'manager';
  // When a real person acted (e.g. a manager clicking an email approve/deny
  // link), name them so the activity feed credits the person, not the actor slug.
  actor_name?: string | null;
  actor_avatar_url?: string | null;
  action: string;
  entity_type?: string;
  entity_id?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(entry: ActivityEntry): Promise<void> {
  const { error } = await supabase.from('activity_log').insert({
    company_id: entry.company_id,
    actor: entry.actor ?? 'aegis',
    actor_name: entry.actor_name ?? null,
    actor_avatar_url: entry.actor_avatar_url ?? null,
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
