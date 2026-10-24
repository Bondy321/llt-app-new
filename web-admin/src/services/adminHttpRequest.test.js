import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ auth: { currentUser: null }, appCheck: vi.fn() }));
vi.mock('../firebase', () => ({ auth: f.auth, getAdminAppCheckToken: f.appCheck }));
import { adminHttpRequest } from './adminHttpRequest';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { vi.useFakeTimers(); f.auth.currentUser = { uid: 'admin', getIdToken: vi.fn().mockResolvedValue('auth') }; f.appCheck.mockResolvedValue('attestation'); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
for (const phase of ['token', 'appCheck', 'fetch', 'body']) it(`bounds admin ${phase} stalls and prevents late dispatch`, async () => {
  const gate = deferred(); const body = { success: true };
  if (phase === 'token') f.auth.currentUser.getIdToken.mockReturnValue(gate.promise);
  if (phase === 'appCheck') f.appCheck.mockReturnValue(gate.promise);
  const fetchFn = vi.fn(async () => phase === 'fetch' ? gate.promise : { ok: true, json: () => phase === 'body' ? gate.promise : Promise.resolve(body) });
  const pending = adminHttpRequest('https://synthetic.invalid/admin', {}, { fetchFn, timeoutMs: 20 });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(21); await rejected;
  const calls = fetchFn.mock.calls.length;
  gate.resolve(phase === 'fetch' ? { ok: true, json: async () => body } : phase === 'body' ? body : 'late-token');
  await vi.advanceTimersByTimeAsync(0); expect(fetchFn).toHaveBeenCalledTimes(calls);
});
for (const phase of ['token', 'body']) it(`rejects same-UID admin replacement during ${phase}`, async () => {
  const gate = deferred();
  if (phase === 'token') f.auth.currentUser.getIdToken.mockReturnValue(gate.promise);
  const fetchFn = vi.fn(async () => ({ ok: true, json: () => gate.promise }));
  const pending = adminHttpRequest('https://synthetic.invalid/admin', {}, { fetchFn });
  const rejected = expect(pending).rejects.toThrow(/account changed/);
  await vi.advanceTimersByTimeAsync(0); f.auth.currentUser = { ...f.auth.currentUser };
  gate.resolve(phase === 'token' ? 'auth' : { success: true }); await rejected;
  if (phase === 'token') expect(fetchFn).not.toHaveBeenCalled();
});
