import { env } from '../config/env';

// Low-level Telnyx Messaging API client (outbound send).
//
// We call the v2 REST API directly (POST https://api.telnyx.com/v2/messages)
// rather than pull in the Telnyx SDK: sending is a single authenticated POST
// with `{ from, to, text }`, and staying on `fetch` keeps the dependency
// surface small (and mirrors how Homebase sends). The `from` number is the
// TENANT's own Telnyx number, resolved per-company by the caller — it is never
// a hardcoded or global value. The messaging profile is bound to the number
// server-side in the Telnyx portal, so it is not sent in the request body.

const TELNYX_MESSAGES_URL = 'https://api.telnyx.com/v2/messages';
const SEND_TIMEOUT_MS = 10_000;

export interface TelnyxSendParams {
  from: string; // E.164, the tenant's own Telnyx number
  to: string; // E.164 recipient
  text: string;
}

export interface TelnyxSendResult {
  ok: boolean;
  id?: string; // Telnyx message id, when the send was accepted
  error?: string;
}

export async function sendTelnyxMessage(
  params: TelnyxSendParams
): Promise<TelnyxSendResult> {
  if (!env.TELNYX_API_KEY) {
    return { ok: false, error: 'TELNYX_API_KEY not configured' };
  }
  if (!params.from) {
    return { ok: false, error: 'missing from number (per-tenant SMS number unresolved)' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(TELNYX_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        from: params.from,
        to: params.to,
        text: params.text,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      return { ok: false, error: `Telnyx ${res.status}: ${detail}` };
    }

    const json = (await res.json()) as { data?: { id?: string } };
    return { ok: true, id: json.data?.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

// Telnyx returns a JSON error envelope ({ errors: [{ detail, ... }] }); fall
// back to raw text if it isn't the expected shape.
async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      errors?: Array<{ detail?: string; title?: string; code?: string }>;
    };
    if (body.errors && body.errors.length > 0) {
      const e = body.errors[0];
      return e.detail || e.title || e.code || 'unknown error';
    }
    return JSON.stringify(body);
  } catch {
    return 'unparseable error response';
  }
}
