import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ auth: { currentUser: null }, reauthenticate: vi.fn(), credential: vi.fn(), getSession: vi.fn(), generateSecret: vi.fn(), enroll: vi.fn(), assertion: vi.fn(), appCheck: vi.fn(), signOut: vi.fn() }));
vi.mock('../firebase', () => ({ auth: f.auth, getAdminAppCheckToken: f.appCheck }));
vi.mock('firebase/auth', () => ({ signOut: f.signOut, EmailAuthProvider: { credential: f.credential }, reauthenticateWithCredential: f.reauthenticate, multiFactor: () => ({ getSession: f.getSession, enroll: f.enroll }), TotpMultiFactorGenerator: { generateSecret: f.generateSecret, assertionForEnrollment: f.assertion } }));
import { beginAdminTotpEnrollment, finishAdminTotpEnrollment, hasAdminSecondFactor, captureAdminIdentityCheck, signOutAdmin } from './adminMfaService';
import { getAdminRequestHeaders } from './adminRequestHeaders';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.resetAllMocks();
  f.auth.currentUser = { uid: 'admin-a', email: 'synthetic@example.invalid', emailVerified: true, getIdToken: vi.fn().mockResolvedValue('synthetic-id-token') };
  f.appCheck.mockResolvedValue('synthetic-app-check'); f.credential.mockReturnValue('credential');
  f.getSession.mockResolvedValue('session'); f.generateSecret.mockResolvedValue('secret'); f.assertion.mockReturnValue('assertion');
});
afterEach(() => vi.useRealTimers());
describe('admin authenticator authorization', () => {
  it('captures the exact auth object for presentation and signs out through the adapter', async () => {
    const current = captureAdminIdentityCheck();
    expect(current()).toBe(true);
    f.auth.currentUser = { ...f.auth.currentUser };
    expect(current()).toBe(false);
    await signOutAdmin();
    expect(f.signOut).toHaveBeenCalledWith(f.auth);
  });
  it('requires a completed TOTP sign-in, not an enrolled factor or arbitrary second factor', () => {
    for (const claims of [null, {}, { admin: true }, { firebase: { sign_in_second_factor: 'phone' } }, { enrolledFactors: ['totp'] }]) expect(hasAdminSecondFactor(claims)).toBe(false);
    expect(hasAdminSecondFactor({ firebase: { sign_in_second_factor: 'totp' } })).toBe(true);
  });
  it('requires verified email and recent password reauthentication before issuing a secret', async () => {
    f.auth.currentUser.emailVerified = false;
    await expect(beginAdminTotpEnrollment('password')).rejects.toThrow(/Verify/);
    expect(f.reauthenticate).not.toHaveBeenCalled();
    f.auth.currentUser.emailVerified = true;
    f.reauthenticate.mockRejectedValueOnce(new Error('wrong password'));
    await expect(beginAdminTotpEnrollment('password')).rejects.toThrow(/wrong password/);
    expect(f.generateSecret).not.toHaveBeenCalled();
    await expect(beginAdminTotpEnrollment('password')).resolves.toEqual({ uid: 'admin-a', secret: 'secret' });
    expect(f.credential).toHaveBeenCalledWith('synthetic@example.invalid', 'password');
    expect(f.generateSecret).toHaveBeenCalledWith('session');
  });
  for (const phase of ['reauthenticate', 'getSession', 'generateSecret']) it(`rejects same-UID auth replacement during ${phase}`, async () => {
    const gate = deferred(); f[phase].mockReturnValueOnce(gate.promise);
    const pending = beginAdminTotpEnrollment('password');
    await vi.waitFor(() => expect(f[phase]).toHaveBeenCalled());
    f.auth.currentUser = { ...f.auth.currentUser };
    gate.resolve('secret');
    await expect(pending).rejects.toThrow(/account changed/);
  });
  it('binds enrollment completion to the intended admin and a six-digit OTP', async () => {
    for (const [enrollment, code] of [[{ uid: 'other' }, '123456'], [{ uid: 'admin-a' }, '12345'], [{ uid: 'admin-a' }, '12a456']]) await expect(finishAdminTotpEnrollment(enrollment, code)).rejects.toThrow(/six-digit/);
    expect(f.enroll).not.toHaveBeenCalled();
    await finishAdminTotpEnrollment({ uid: 'admin-a', secret: 'secret' }, '123456');
    expect(f.assertion).toHaveBeenCalledWith('secret', '123456');
    expect(f.enroll).toHaveBeenCalledWith('assertion', 'LLT operations');
  });
  it('does not report successful enrollment after logout while the enrollment is pending', async () => {
    const gate = deferred(); f.enroll.mockReturnValueOnce(gate.promise);
    const pending = finishAdminTotpEnrollment({ uid: 'admin-a', secret: 'secret' }, '123456');
    f.auth.currentUser = null; gate.resolve();
    await expect(pending).rejects.toThrow(/account changed/);
  });
});
describe('admin request credential boundary', () => {
  it('includes both current credentials and rejects missing authentication', async () => {
    expect(await getAdminRequestHeaders()).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-id-token', 'X-Firebase-AppCheck': 'synthetic-app-check' });
    f.auth.currentUser = null;
    await expect(getAdminRequestHeaders()).rejects.toThrow(/Sign in/);
  });
  it('does not downgrade an App Check provider failure to an unprotected request', async () => {
    f.appCheck.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(getAdminRequestHeaders()).rejects.toThrow(/provider unavailable/);
  });
  it('discards both credentials when the auth user changes before acquisition finishes', async () => {
    const gate = deferred(); f.appCheck.mockReturnValueOnce(gate.promise);
    const pending = getAdminRequestHeaders();
    await vi.waitFor(() => expect(f.appCheck).toHaveBeenCalled());
    f.auth.currentUser = { ...f.auth.currentUser }; gate.resolve('old-app-check');
    await expect(pending).rejects.toThrow(/account changed/);
  });
  it('bounds a stalled credential provider', async () => {
    vi.useFakeTimers(); f.appCheck.mockReturnValueOnce(new Promise(() => {}));
    const result = expect(getAdminRequestHeaders()).rejects.toThrow(/did not finish/);
    await vi.advanceTimersByTimeAsync(15001); await result;
  });
});
