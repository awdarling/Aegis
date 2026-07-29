import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Control env for the module under test (telnyx.ts reads env.TELNYX_API_KEY).
vi.mock('../../config/env', () => ({
  env: { TELNYX_API_KEY: 'test_key_123' },
}));

import { sendTelnyxMessage } from '../telnyx';

describe('sendTelnyxMessage — outbound wire format', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs {from,to,text} to the Telnyx v2 messages API with a Bearer key', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'msg_abc' } }),
    });

    const result = await sendTelnyxMessage({ from: '+16166164898', to: '+16165550123', text: 'hi there' });

    expect(result).toEqual({ ok: true, id: 'msg_abc' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test_key_123');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ from: '+16166164898', to: '+16165550123', text: 'hi there' });
  });

  it('returns a descriptive error on a non-2xx Telnyx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ errors: [{ detail: 'from number not owned' }] }),
    });

    const result = await sendTelnyxMessage({ from: '+1', to: '+2', text: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('422');
    expect(result.error).toContain('from number not owned');
  });

  it('returns ok:false on a network error (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const result = await sendTelnyxMessage({ from: '+1', to: '+2', text: 'x' });
    expect(result).toEqual({ ok: false, error: 'ECONNRESET' });
  });

  it('refuses to send with no from number (per-tenant number unresolved)', async () => {
    const result = await sendTelnyxMessage({ from: '', to: '+2', text: 'x' });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
