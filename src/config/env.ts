import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Telnyx (SMS provider) — OPTIONAL. When unset, Aegis boots normally and runs
  // email-first: outbound SMS is skipped (sendSms returns false) and the inbound
  // SMS webhook rejects unsigned requests. The sending NUMBER is NOT here — each
  // tenant's own Telnyx number lives in company_channels (channel_type='sms'),
  // resolved per-tenant, so this config is number-agnostic across clients.
  //   TELNYX_API_KEY               — v2 API key (Bearer) for outbound send
  //   TELNYX_PUBLIC_KEY            — base64 Ed25519 key to verify inbound webhooks
  //   TELNYX_MESSAGING_PROFILE_ID  — the messaging profile (portal/webhook config;
  //                                  not sent in the request body — bound to the
  //                                  number server-side)
  // (SKIP_TELNYX_VERIFICATION is read straight from process.env for local/Tier-0
  // testing, never in production — see src/middleware/verify-signature.ts.)
  TELNYX_API_KEY: z.string().optional(),
  TELNYX_PUBLIC_KEY: z.string().optional(),
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),

  // EMAIL-ONLY MODE. While true (the default), every workflow runs over email
  // and SMS is fully disabled — outbound SMS is skipped, the inbound SMS webhook
  // is inert, and channel selection always resolves to email so phone-on-file
  // employees are emailed rather than silently dropped. This is the intended
  // state until the consent chain clears counsel; nothing is deleted, so setting
  // EMAIL_ONLY=false (and configuring Telnyx) restores SMS behavior.
  EMAIL_ONLY: z.string().default('true').transform((s) => s.toLowerCase() !== 'false'),

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
