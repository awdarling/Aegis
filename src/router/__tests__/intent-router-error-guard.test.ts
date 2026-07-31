import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fully mock every module intent-router imports so importing routeIntent is
// side-effect-free and we can force a pre-classification handler to throw.
const h = vi.hoisted(() => ({
  getPendingTimeOff: vi.fn(),
  getOnboardingSessionByPhone: vi.fn(),
  getOnboardingSessionByEmail: vi.fn(),
  classifyIntent: vi.fn(),
  reply: vi.fn(),
}));

vi.mock('../../ai/claude', () => ({ classifyIntent: h.classifyIntent, AnthropicOverloadError: class AnthropicOverloadError extends Error {} }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: h.reply }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({ insert: vi.fn() }) } }));
vi.mock('../../workflows/time-off', () => ({
  handleSubmitTimeOff: vi.fn(), handleApproveTimeOff: vi.fn(), handleDenyTimeOff: vi.fn(),
  handlePendingTimeOffConfirmation: vi.fn(), handleQueryMyTimeOff: vi.fn(), handleRecheckTimeOff: vi.fn(),
  getPendingTimeOff: h.getPendingTimeOff,
}));
vi.mock('../../workflows/schedule-build', () => ({ handleBuildSchedule: vi.fn(), handleDistributeSchedule: vi.fn() }));
vi.mock('../../workflows/operational-query', () => ({
  handleOperationalQuery: vi.fn(), handleMyShiftsQuery: vi.fn(), handleHomebaseEdit: vi.fn(),
  handleEditConfirmation: vi.fn(), getPendingEdit: vi.fn(),
}));
vi.mock('../../workflows/shift-swap', () => ({
  handleInitiateSwap: vi.fn(), handleRespondSwap: vi.fn(), handleApproveSwap: vi.fn(), handleDenySwap: vi.fn(),
  handleSwapConfirmation: vi.fn(), handleSwapOutreachResponse: vi.fn(), getPendingSwap: vi.fn(), getActiveSwapOutreach: vi.fn(),
}));
vi.mock('../../workflows/emergency-coverage', () => ({
  handleEmergencyCoverage: vi.fn(), routeManagerCoverageReply: vi.fn(), handleEmployeeCoverageResponse: vi.fn(), getActiveOutreach: vi.fn(),
}));
vi.mock('../../workflows/payroll', () => ({ handlePayrollCheck: vi.fn() }));
vi.mock('../../workflows/employee-onboarding', () => ({
  getOnboardingSession: vi.fn(), getOnboardingSessionByPhone: h.getOnboardingSessionByPhone,
  getOnboardingSessionByEmail: h.getOnboardingSessionByEmail, handleOnboardingResponse: vi.fn(),
  handleInitiateOnboarding: vi.fn(), getPendingAvailConfirm: vi.fn(), handleAvailabilityConfirmResponse: vi.fn(),
  handleUpdateAvailability: vi.fn(), getPendingManagerAvailApproval: vi.fn(), handleManagerAvailabilityApproval: vi.fn(),
  getOnboardingFanoutPending: vi.fn(), handleOnboardingFanoutConfirm: vi.fn(), getPendingIntentSwitch: vi.fn(),
  clearPendingIntentSwitch: vi.fn(), clearPendingAvailConfirm: vi.fn(), buildAvailChangeConfirmBody: vi.fn(),
  classifyAffirmation: vi.fn(),
}));
vi.mock('../../workflows/broadcast', () => ({ handleBroadcast: vi.fn(), handleBroadcastConfirmation: vi.fn(), getActiveBroadcastSession: vi.fn() }));
vi.mock('../../workflows/day-closure', () => ({ handleNotifyDayClosure: vi.fn() }));
vi.mock('../capabilities', () => ({ buildCapabilitiesReply: vi.fn(() => 'help'), allowedActionsLine: vi.fn(() => 'stuff') }));

import { routeIntent } from '../intent-router';

const message: any = { channel: 'sms', sender: '+16165550100', recipient: '+16166164898', body: 'hey' };
const contact: any = { role: 'employee', employee_id: 'e1', company_id: 'c1', name: 'Sam', matched_identifier: '+16165550100' };

describe('routeIntent — pre-classification error guard (Batch A4)', () => {
  beforeEach(() => {
    h.getOnboardingSessionByPhone.mockResolvedValue(null);
    h.getOnboardingSessionByEmail.mockResolvedValue(null);
    h.classifyIntent.mockReset();
    h.reply.mockReset();
    h.getPendingTimeOff.mockReset();
  });

  it('a throwing pending-session handler sends a graceful reply, not a silent crash', async () => {
    h.getPendingTimeOff.mockRejectedValue(new Error('DB exploded'));

    await expect(routeIntent(message, contact)).resolves.toBeUndefined();

    expect(h.reply).toHaveBeenCalledTimes(1);
    const args = h.reply.mock.calls[0];
    expect(args[2]).toMatch(/Something went wrong on my end/);
    // Proof the failure was caught BEFORE classification, not after.
    expect(h.classifyIntent).not.toHaveBeenCalled();
  });
});
