import twilio from 'twilio';
import { env } from '../config/env';
import { saveConversation } from '../logger/conversation';

// Twilio is optional (SMS migrating to Telgorithm). When creds are absent the
// client is null and sendSms becomes a safe no-op — email workflows that try an
// SMS fallback simply get `false`, exactly as if the send had failed.
const twilioClient =
  env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
    ? twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
    : null;

interface SmsOptions {
  to: string;
  from: string; // Twilio number (the company's dedicated line)
  body: string;
  company_id: string;
}

export async function sendSms(options: SmsOptions): Promise<boolean> {
  if (!twilioClient) {
    console.warn('[sms] Twilio not configured — SMS disabled (email-first mode). Skipping send.');
    return false;
  }
  try {
    const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;
    const fromNumber = options.from || env.TWILIO_FROM_NUMBER;

    const payload: { to: string; body: string; from?: string; messagingServiceSid?: string } = {
      to: options.to,
      body: options.body,
    };
    if (messagingServiceSid) {
      payload.messagingServiceSid = messagingServiceSid;
    } else if (fromNumber) {
      payload.from = fromNumber;
    } else {
      throw new Error('No TWILIO_MESSAGING_SERVICE_SID or from number configured');
    }

    await twilioClient.messages.create(payload);

    await saveConversation({
      company_id: options.company_id,
      channel: 'sms',
      direction: 'outbound',
      content: options.body,
      from_address: messagingServiceSid || fromNumber || '',
      to_address: options.to,
    });
    return true;
  } catch (err) {
    console.error('[sms] send failed:', err);
    return false;
  }
}
