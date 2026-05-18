import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';

// ── Retry / overload handling ─────────────────────────────────────────────────
// NOTE: The Homebase Soteria routes
// (src/app/api/soteria-validate-schedule/route.ts and
// src/app/api/soteria-validate-assignment/route.ts) live in a different repo
// and make their own Anthropic calls — they need the same retry treatment as
// what is implemented here. Follow-up in the Homebase repo.

export class AnthropicOverloadError extends Error {
  constructor(message = 'Anthropic API overloaded after 3 attempts') {
    super(message);
    this.name = 'AnthropicOverloadError';
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000]; // delay before attempt 2, then before attempt 3
const RETRYABLE_STATUSES = new Set([500, 503, 529]);

function getRetryableStatus(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number' && RETRYABLE_STATUSES.has(status)) {
      return status;
    }
  }
  return null;
}

export async function withAnthropicRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const status = getRetryableStatus(err);
      if (status === null) throw err;
      lastErr = err;
      lastStatus = status;
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1];
        console.log(
          `[claude] API overloaded, retry attempt ${attempt + 1}/${MAX_ATTEMPTS} in ${delayMs / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  if (lastStatus === 529) {
    throw new AnthropicOverloadError();
  }
  throw lastErr;
}

export interface ClassifyResult {
  intent: string;
  confidence: 'high' | 'medium' | 'low';
  extracted: Record<string, unknown>;
}

// ── Intent lists by role ──────────────────────────────────────────────────────

export const EMPLOYEE_INTENTS = [
  'submit_time_off',
  'update_availability',
  'initiate_swap',
  'respond_swap_accept',
  'respond_swap_decline',
  'operational_query',
  'general_question',
] as const;

export const MANAGER_INTENTS = [
  ...EMPLOYEE_INTENTS,
  'approve_time_off',
  'deny_time_off',
  'approve_swap',
  'deny_swap',
  'initiate_onboarding',
  'request_emergency_coverage',
  'build_schedule',
  'distribute_schedule',
  'run_payroll_check',
  'homebase_edit',
] as const;

export const QURIA_INTENTS = [
  ...MANAGER_INTENTS,
  'broadcast_message',
  'quria_diagnostic',
] as const;

// ── Public API ────────────────────────────────────────────────────────────────

// Classifies the intent of an inbound message given the caller's role.
// Returns structured JSON — if parsing fails, intent is 'unknown'.
export async function classifyIntent(
  message: string,
  role: 'employee' | 'manager' | 'quria_admin',
  companyContext: string
): Promise<ClassifyResult> {
  const systemPrompt = buildClassifySystemPrompt(role, companyContext);

  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    })
  );

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    return JSON.parse(text) as ClassifyResult;
  } catch {
    return { intent: 'unknown', confidence: 'low', extracted: {} };
  }
}

// Generates a natural language reply to send back to the user.
export async function generateReply(
  systemPrompt: string,
  userMessage: string,
  contextBlocks: string[]
): Promise<string> {
  const fullSystem = [systemPrompt, ...contextBlocks].join('\n\n');

  const response = await withAnthropicRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: fullSystem,
      messages: [{ role: 'user', content: userMessage }],
    })
  );

  return response.content[0].type === 'text' ? response.content[0].text : '';
}

// ── Classifier system prompt ──────────────────────────────────────────────────

function buildClassifySystemPrompt(
  role: 'employee' | 'manager' | 'quria_admin',
  companyContext: string
): string {
  const allowedIntents: readonly string[] =
    role === 'quria_admin' ? QURIA_INTENTS :
    role === 'manager'     ? MANAGER_INTENTS :
                             EMPLOYEE_INTENTS;

  return `You are an intent classifier for Aegis, an AI workforce assistant.
The sender is a ${role}. Classify their message into exactly one intent.

Allowed intents: ${allowedIntents.join(', ')}, unknown

${companyContext}

Respond with ONLY valid JSON in this exact shape — no markdown, no explanation:
{
  "intent": "<intent_name>",
  "confidence": "high" | "medium" | "low",
  "extracted": {
    // Any structured data you can extract from the message.
    // For submit_time_off: { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "reason": "..." }
    // For initiate_swap: { "shift_date": "YYYY-MM-DD", "shift_name": "...", "target_employee_name": "..." }
    // For build_schedule: { "target_week": "this" | "next", "veteran_preference": string | null }
    //   target_week: "next" if unspecified. Map "this week", "current week" → "this". Map "next week", "upcoming week", "the week after" → "next".
    //   Never emit a calendar date — you do not know today's date reliably.
    //   veteran_preference: free-text capturing any veteran-related scheduling preference (e.g. "veterans only", "prioritize veterans", "at least one veteran per shift"). null if no veteran preference mentioned.
    // For distribute_schedule: {}
    // For homebase_edit: { "entity_type": "employee|event|policy|wage_rate|shift_type", "entity_name": "...", "field": "...", "new_value": "..." }
    // For initiate_onboarding: { "employee_name": "..." } if targeting one employee, or {} for all
    // For update_availability: {}
    // For operational_query: {}
    // For run_payroll_check: { "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD" }
    // For broadcast_message: { "message_text": "exact message to send", "target_type": "all|managers|employees|role|specific", "target_role": "Lifeguard|null", "target_names": ["Name1"]|null, "channel": "sms|email|both" }
    // Otherwise: {}
  }
}`;
}
