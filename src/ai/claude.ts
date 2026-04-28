import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';

export interface ClassifyResult {
  intent: string;
  confidence: 'high' | 'medium' | 'low';
  extracted: Record<string, unknown>;
}

// Classifies the intent of an inbound message given caller role context.
// Returns structured JSON — if parsing fails, intent is 'unknown'.
export async function classifyIntent(
  message: string,
  role: 'employee' | 'manager',
  companyContext: string
): Promise<ClassifyResult> {
  const systemPrompt = buildClassifySystemPrompt(role, companyContext);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  });

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

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: fullSystem,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : '';
}

function buildClassifySystemPrompt(role: 'employee' | 'manager', companyContext: string): string {
  const employeeIntents = [
    'submit_time_off',
    'initiate_swap',
    'respond_swap_accept',
    'respond_swap_decline',
    'general_question',
    'operational_query',
  ];

  const managerIntents = [
    ...employeeIntents,
    'build_schedule',
    'distribute_schedule',
    'approve_time_off',
    'deny_time_off',
    'approve_swap',
    'deny_swap',
    'request_emergency_coverage',
    'operational_query',
    'homebase_edit',
  ];

  const allowedIntents = role === 'manager' ? managerIntents : employeeIntents;

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
    // For time_off: { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "reason": "..." }
    // For swap: { "shift_date": "YYYY-MM-DD", "shift_name": "...", "target_employee_name": "..." }
    // For schedule/distribute_schedule: { "week_start": "YYYY-MM-DD" }
    // For homebase_edit: { "entity_type": "employee|event|policy|wage_rate|shift_type", "entity_name": "...", "field": "...", "new_value": "..." }
    // For operational_query: {}
    // Otherwise: {}
  }
}`;
}
