import crypto from 'crypto';
import { supabase } from '../../db/client';
import type {
  GenerateTokenParams,
  GenerateTokenResult,
} from './types';

const DEFAULT_TTL_MINUTES = 72 * 60;
const DEFAULT_HOMEBASE_URL = 'https://homebase-nine-phi.vercel.app';

let warnedMissingHomebaseUrl = false;

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function generateRawToken(): string {
  return crypto
    .randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function buildActionUrl(rawToken: string): string {
  const configured = process.env.HOMEBASE_URL;
  if (!configured && !warnedMissingHomebaseUrl) {
    warnedMissingHomebaseUrl = true;
    console.warn(
      `[aegis-actions] HOMEBASE_URL not set; falling back to ${DEFAULT_HOMEBASE_URL}`
    );
  }
  const homebaseUrl = configured ?? DEFAULT_HOMEBASE_URL;
  return `${homebaseUrl}/api/aegis-action?token=${encodeURIComponent(rawToken)}`;
}

export async function generateActionToken(
  params: GenerateTokenParams
): Promise<GenerateTokenResult> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const ttlMinutes = params.ttl_minutes ?? DEFAULT_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const { error } = await supabase.from('aegis_action_tokens').insert({
    company_id: params.company_id,
    token_hash: tokenHash,
    action_type: params.action_type,
    payload: params.payload,
    issued_to_email: params.issued_to_email,
    issued_to_employee_id: params.issued_to_employee_id ?? null,
    issued_to_user_id: params.issued_to_user_id ?? null,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw new Error(
      `Failed to insert aegis_action_tokens row (company=${params.company_id}, action_type=${params.action_type}): ${error.message}`
    );
  }

  return {
    url: buildActionUrl(rawToken),
    raw_token: rawToken,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
  };
}
