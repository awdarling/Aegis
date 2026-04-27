import { supabase } from '../db/client';

interface ConversationRecord {
  company_id: string;
  channel: 'email' | 'sms';
  direction: 'inbound' | 'outbound';
  content: string;
  from_address?: string;
  to_address?: string;
  subject?: string;
  thread_id?: string;
}

export async function saveConversation(record: ConversationRecord): Promise<string | null> {
  const { data, error } = await supabase
    .from('aegis_conversations')
    .insert({
      company_id: record.company_id,
      channel: record.channel,
      direction: record.direction,
      content: record.content,
      from_address: record.from_address ?? null,
      to_address: record.to_address ?? null,
      subject: record.subject ?? null,
      thread_id: record.thread_id ?? null,
      processed: false,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[conversation] failed to save:', error.message);
    return null;
  }

  return data.id;
}
