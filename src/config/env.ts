import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  // SendGrid
  SENDGRID_API_KEY: z.string().min(1),
  SENDGRID_WEBHOOK_VERIFICATION_KEY: z.string().optional(),
  // PEM-encoded ECDSA public key from the SendGrid Inbound Parse security
  // policy. When set, the email webhook enforces signature verification and
  // rejects unsigned/invalid requests. When unset, falls back to the legacy
  // IP allowlist so production keeps working until the policy is attached.
  SENDGRID_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  // The domain from which Aegis sends outbound emails, e.g. aegis@mail.yourdomain.com
  SENDGRID_FROM_EMAIL: z.string().email(),
  SENDGRID_FROM_NAME: z.string().default('Aegis'),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),

  // Public base URL for this service (used in email decision links)
  BASE_URL: z.string().url().default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  for (const [field, errors] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${(errors as string[]).join(', ')}`);
  }
  process.exit(1);
}

export const env = parsed.data;
