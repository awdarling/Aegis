import { describe, it, expect, vi } from 'vitest';

// Fully mock every module intent-router imports so importing the pure predicate
// is side-effect-free (mirrors intent-router-error-guard.test.ts).
vi.mock('../../ai/claude', () => ({ classifyIntent: vi.fn(), AnthropicOverloadError: class AnthropicOverloadError extends Error {} }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn() }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({ insert: vi.fn() }) } }));
vi.mock('../../workflows/time-off', () => ({
  handleSubmitTimeOff: vi.fn(), handleApproveTimeOff: vi.fn(), handleDenyTimeOff: vi.fn(),
  handlePendingTimeOffConfirmation: vi.fn(), handleQueryMyTimeOff: vi.fn(), handleRecheckTimeOff: vi.fn(),
  getPendingTimeOff: vi.fn(),
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
  getOnboardingSession: vi.fn(), getOnboardingSessionByPhone: vi.fn(),
  getOnboardingSessionByEmail: vi.fn(), handleOnboardingResponse: vi.fn(),
  handleInitiateOnboarding: vi.fn(), getPendingAvailConfirm: vi.fn(), handleAvailabilityConfirmResponse: vi.fn(),
  handleUpdateAvailability: vi.fn(), getPendingManagerAvailApproval: vi.fn(), handleManagerAvailabilityApproval: vi.fn(),
  getOnboardingFanoutPending: vi.fn(), handleOnboardingFanoutConfirm: vi.fn(), getPendingIntentSwitch: vi.fn(),
  clearPendingIntentSwitch: vi.fn(), clearPendingAvailConfirm: vi.fn(), buildAvailChangeConfirmBody: vi.fn(),
  classifyAffirmation: vi.fn(),
}));
vi.mock('../../workflows/broadcast', () => ({ handleBroadcast: vi.fn(), handleBroadcastConfirmation: vi.fn(), getActiveBroadcastSession: vi.fn() }));
vi.mock('../../workflows/day-closure', () => ({ handleNotifyDayClosure: vi.fn() }));
vi.mock('../capabilities', () => ({ buildCapabilitiesReply: vi.fn(() => 'help'), allowedActionsLine: vi.fn(() => 'stuff') }));

import { shouldProcessAvailApprovalReply } from '../intent-router';

describe('shouldProcessAvailApprovalReply — availability approval is inbox-only (batch 2c)', () => {
  it('never processes an SMS reply (no employment action over SMS)', () => {
    expect(shouldProcessAvailApprovalReply('sms', 'no')).toBe(false);
    expect(shouldProcessAvailApprovalReply('sms', 'yes')).toBe(false);
  });
  it('processes a clear email yes/no reply', () => {
    expect(shouldProcessAvailApprovalReply('email', 'no')).toBe(true);
    expect(shouldProcessAvailApprovalReply('email', 'yes, approve it')).toBe(true);
  });
  it('does NOT swallow a non-decision email (a fresh call-out routes to its real intent)', () => {
    expect(shouldProcessAvailApprovalReply('email', 'Casey called out and needs coverage Saturday')).toBe(false);
  });
});
