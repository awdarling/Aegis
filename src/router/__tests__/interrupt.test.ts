import { describe, it, expect, vi, beforeEach } from 'vitest';

// H7 — unit tests for the pending-session interrupt DECISION logic. Proves which
// intents interrupt (and under which allowQueries gate), that a bare name never
// interrupts, and that the tenant timezone is injected into the classifier.

const classifyIntent = vi.fn();
vi.mock('../../ai/claude', () => ({
  classifyIntent: (...a: unknown[]) => classifyIntent(...a),
}));

let TZ: string | null = 'America/Detroit';
vi.mock('../../db/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: () => Promise.resolve({ data: { timezone: TZ }, error: null }) }),
      }),
    }),
  },
}));

import {
  managerInterruptIntent,
  employeeInterruptIntent,
  classifyInterruptIntent,
  INTERRUPTING_MANAGER_ACTION_INTENTS,
  INTERRUPTING_MANAGER_QUERY_INTENTS,
  INTERRUPTING_EMPLOYEE_INTENTS,
} from '../interrupt';
import type { InboundMessage, VerifiedContact } from '../../security/types';

const msg = (body: string): InboundMessage => ({
  sender: 'm@club.com', recipient: 'aegis@club.com', body, channel: 'sms',
});
const mgr: VerifiedContact = {
  role: 'manager', company_id: 'co-1', employee_id: null, user_id: 'u1',
  name: 'Manager', matched_identifier: 'm@club.com', channel: 'sms',
};
const emp: VerifiedContact = {
  role: 'employee', company_id: 'co-1', employee_id: 'e1', user_id: null,
  name: 'Sam', matched_identifier: 's@club.com', channel: 'sms',
};

beforeEach(() => {
  TZ = 'America/Detroit';
  classifyIntent.mockReset();
  classifyIntent.mockResolvedValue({ intent: 'general_question', confidence: 'low', extracted: {} });
});

describe('H7 interrupt classification', () => {
  it('injects the tenant timezone (never server UTC) into classifyIntent', async () => {
    classifyIntent.mockResolvedValue({ intent: 'approve_swap', confidence: 'high', extracted: {} });
    await classifyInterruptIntent(msg('approve the swap'), mgr);
    expect(classifyIntent).toHaveBeenCalledWith('approve the swap', 'manager', '', 'America/Detroit');
  });

  it('falls back to a default timezone when the tenant has none', async () => {
    TZ = null;
    classifyIntent.mockResolvedValue({ intent: 'build_schedule', confidence: 'high', extracted: {} });
    await classifyInterruptIntent(msg('build the schedule'), mgr);
    expect(classifyIntent).toHaveBeenCalledWith('build the schedule', 'manager', '', 'America/New_York');
  });

  it('manager: an ACTION intent interrupts regardless of allowQueries', async () => {
    classifyIntent.mockResolvedValue({ intent: 'approve_swap', confidence: 'high', extracted: {} });
    expect(await managerInterruptIntent(msg("approve Sam's swap"), mgr, { allowQueries: false })).toBe('approve_swap');
    expect(await managerInterruptIntent(msg("approve Sam's swap"), mgr, { allowQueries: true })).toBe('approve_swap');
  });

  it('manager: a QUERY intent interrupts ONLY when allowQueries is true', async () => {
    classifyIntent.mockResolvedValue({ intent: 'operational_query', confidence: 'high', extracted: {} });
    expect(await managerInterruptIntent(msg("who's free saturday"), mgr, { allowQueries: false })).toBeNull();
    expect(await managerInterruptIntent(msg("who's free saturday"), mgr, { allowQueries: true })).toBe('operational_query');
  });

  it('manager: a bare name (general_question) never interrupts, even with queries allowed', async () => {
    classifyIntent.mockResolvedValue({ intent: 'general_question', confidence: 'low', extracted: {} });
    expect(await managerInterruptIntent(msg('Kori'), mgr, { allowQueries: false })).toBeNull();
    expect(await managerInterruptIntent(msg('Kori'), mgr, { allowQueries: true })).toBeNull();
  });

  it('employee: a subject-changing intent interrupts an unconfirmed swap', async () => {
    classifyIntent.mockResolvedValue({ intent: 'submit_time_off', confidence: 'high', extracted: {} });
    expect(await employeeInterruptIntent(msg('actually I need Friday off'), emp)).toBe('submit_time_off');
  });

  it('employee: a fumbled yes/no (general_question) does not interrupt', async () => {
    classifyIntent.mockResolvedValue({ intent: 'general_question', confidence: 'low', extracted: {} });
    expect(await employeeInterruptIntent(msg('idk maybe'), emp)).toBeNull();
  });

  it('taxonomy: general_question is never an interrupt trigger anywhere', () => {
    expect(INTERRUPTING_MANAGER_ACTION_INTENTS.has('general_question')).toBe(false);
    expect(INTERRUPTING_MANAGER_QUERY_INTENTS.has('general_question')).toBe(false);
    expect(INTERRUPTING_EMPLOYEE_INTENTS.has('general_question')).toBe(false);
    expect(INTERRUPTING_MANAGER_ACTION_INTENTS.has('approve_swap')).toBe(true);
    expect(INTERRUPTING_MANAGER_QUERY_INTENTS.has('operational_query')).toBe(true);
    expect(INTERRUPTING_EMPLOYEE_INTENTS.has('initiate_swap')).toBe(true);
  });
});
