// ── N-2 / N-4 — the aegis_memory token store, hardened (2026-08-28) ──────────
//
// Aegis's swap / coverage / departure buttons store their one-time tokens as
// aegis_memory rows keyed `decision_token:<value>` / `departure_token:<value>`.
// Two audit findings live here:
//
//   N-2 — the token VALUE used to be stored in plain text, and aegis_memory's
//         RLS policy grants every company login full access. Anyone who could
//         read the table could lift a live token and act as the manager it was
//         minted for. Fix: store only a SHA-256 digest of the token (the same
//         scheme the Homebase aegis_action_tokens table uses). The raw value
//         exists only inside the emailed link; the database can no longer leak
//         a usable token.
//
//   N-4 — expired tokens were deleted only if someone happened to click them
//         after expiry; 112 expired rows sat in the live table on 2026-08-28.
//         Fix: purgeExpiredDecisionTokens(), run by the daily scheduler sweep.
//
// Legacy compatibility: tokens minted BEFORE this change are stored in plain
// text and live for up to 7 days. findTokenRow therefore looks up the hashed
// source first and falls back to the legacy plaintext source, so in-flight
// emailed links keep working across the deploy. The fallback costs one extra
// indexed lookup only on a miss, and becomes dead code once pre-deploy tokens
// have expired (purged by the sweep).

import crypto from 'crypto';
import { supabase } from '../db/client';

export type TokenPrefix = 'decision_token' | 'departure_token';

export function hashDecisionToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** The aegis_memory `source` value to STORE for a freshly minted token. */
export function mintTokenSource(prefix: TokenPrefix, raw: string): string {
  return `${prefix}:${hashDecisionToken(raw)}`;
}

export interface TokenRow {
  id: string;
  content: string;
  /** The source the row was actually found under (hashed or legacy plaintext). */
  source: string;
}

/**
 * Look up a token presented in a URL. Hashed source first (current scheme),
 * legacy plaintext second (tokens minted before the N-2 fix). Returns null when
 * neither exists — the caller renders its truthful missing-token page.
 */
export async function findTokenRow(prefix: TokenPrefix, raw: string): Promise<TokenRow | null> {
  const hashedSource = `${prefix}:${hashDecisionToken(raw)}`;
  const { data: hashedRow } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('source', hashedSource)
    .maybeSingle();
  if (hashedRow) {
    const r = hashedRow as { id: string; content: string };
    return { id: r.id, content: r.content, source: hashedSource };
  }
  const legacySource = `${prefix}:${raw}`;
  const { data: legacyRow } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('source', legacySource)
    .maybeSingle();
  if (legacyRow) {
    const r = legacyRow as { id: string; content: string };
    return { id: r.id, content: r.content, source: legacySource };
  }
  return null;
}

export async function deleteTokenRowBySource(source: string): Promise<void> {
  await supabase.from('aegis_memory').delete().eq('source', source);
}

// ── N-4 — the broom ──────────────────────────────────────────────────────────
//
// Deletes (a) aegis_memory token/parked-state rows whose own expires_at has
// passed — decision_token, departure_token, and the callout_decision parked
// text-reply rows — and (b) expired aegis_action_tokens rows (976 sat expired
// and unconsumed in the live table on 2026-08-28; the consumed ones are just
// as dead once expired — the audit record of a decision is activity_log, not
// the token row). Content is parsed defensively: a malformed row without a
// readable expires_at is left alone rather than guessed at.
export async function purgeExpiredDecisionTokens(): Promise<{ memoryRows: number; actionTokenRows: number }> {
  let memoryRows = 0;
  const now = new Date();
  for (const prefix of ['decision_token:%', 'departure_token:%', 'callout_decision:%']) {
    const { data, error } = await supabase
      .from('aegis_memory')
      .select('id, content')
      .like('source', prefix);
    if (error) {
      console.error(`[token-purge] listing ${prefix} rows failed:`, error.message);
      continue;
    }
    const expiredIds = ((data ?? []) as Array<{ id: string; content: string }>)
      .filter(r => {
        try {
          const expires = (JSON.parse(r.content) as { expires_at?: string }).expires_at;
          return !!expires && new Date(expires) < now;
        } catch {
          return false;
        }
      })
      .map(r => r.id);
    if (expiredIds.length > 0) {
      const { error: delErr } = await supabase.from('aegis_memory').delete().in('id', expiredIds);
      if (delErr) console.error(`[token-purge] deleting expired ${prefix} rows failed:`, delErr.message);
      else memoryRows += expiredIds.length;
    }
  }

  const { data: purgedTokens, error: aatErr } = await supabase
    .from('aegis_action_tokens')
    .delete()
    .lt('expires_at', now.toISOString())
    .select('id');
  let actionTokenRows = 0;
  if (aatErr) {
    console.error('[token-purge] deleting expired aegis_action_tokens failed:', aatErr.message);
  } else {
    actionTokenRows = (purgedTokens ?? []).length;
  }

  if (memoryRows > 0 || actionTokenRows > 0) {
    console.log(`[token-purge] purged ${memoryRows} expired aegis_memory token row(s) and ${actionTokenRows} expired aegis_action_tokens row(s)`);
  }
  return { memoryRows, actionTokenRows };
}
