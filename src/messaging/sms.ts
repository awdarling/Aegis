import twilio from 'twilio';
import { env } from '../config/env';
import { saveConversation } from '../logger/conversation';

const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

interface SmsOptions {
  to: string;
  from: string; // Twilio number (the company's dedicated line)
  body: string;
  company_id: string;
}

export async function sendSms(options: SmsOptions): Promise<boolean> {
  try {
    await twilioClient.messages.create({
      to: options.to,
      from: options.from,
      body: options.body,
    });

    await saveConversation({
      company_id: options.company_id,
      channel: 'sms',
      direction: 'outbound',
      content: options.body,
      from_address: options.from,
      to_address: options.to,
    });
    return true;
  } catch (err) {
    console.error('[sms] send failed:', err);
    return false;
  }
}
