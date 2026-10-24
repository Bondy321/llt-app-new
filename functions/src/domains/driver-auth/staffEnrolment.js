'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { captureInstallationAuthority } = require('../../../lib/sessionPublicationAuthority');
const digest = text => createHash('sha256').update(text).digest('hex');
const failure = code => Object.assign(new Error('Staff device approval is unavailable'), { code });
const ENROLMENT_TTL_MS = 10 * 60 * 1000;

// Driver IDs remain public identifiers. Only an independently approved device
// and matching current staff generation may create a privileged session.
const issueStaffEnrolment = async ({ db, driverId, adminUid, replace = false, nowMs = Date.now() }) => {
  const driver = (await db.ref(`drivers/${driverId}`).once('value')).val();
  if (!driver || typeof driver !== 'object') throw failure('DRIVER_NOT_FOUND');
  const generation = randomBytes(24).toString('hex');
  const policy = await db.ref(`driver_staff_policy/${driverId}`).transaction(current => {
    if (current && current.schemaVersion !== 1) return undefined;
    if (current && !replace) return current;
    return { schemaVersion: 1, generation, updatedAtMs: nowMs, updatedBy: adminUid,
      action: replace ? 'replace' : 'enrol' };
  }, undefined, false);
  if (!policy.committed) throw failure('STAFF_POLICY_INVALID');
  const secret = `LLT1-${randomBytes(32).toString('base64url')}`;
  const secretHash = digest(secret);
  await db.ref(`driver_enrolments/${secretHash}`).set({ schemaVersion: 1,
    driverId, generation: policy.snapshot.val().generation, secretHash,
    createdAtMs: nowMs, expiresAtMs: nowMs + ENROLMENT_TTL_MS,
    createdBy: adminUid, state: 'issued' });
  return { secret, driverId, expiresAtMs: nowMs + ENROLMENT_TTL_MS, replaced: replace };
};

const revokeStaffEnrolment = async ({ db, driverId, adminUid, nowMs = Date.now() }) => {
  const generation = randomBytes(24).toString('hex');
  const result = await db.ref(`driver_staff_policy/${driverId}`).transaction(current => {
    if (current && current.schemaVersion !== 1) return undefined;
    return { schemaVersion: 1, generation, updatedAtMs: nowMs, updatedBy: adminUid, action: 'revoke' };
  }, undefined, false);
  if (!result.committed) throw failure('STAFF_POLICY_INVALID');
  return { revoked: true, driverId };
};

const receiptRecoveryMatches = ({ currentAuthority, redemptionId, current }) => {
  const authority = currentAuthority.value;
  const staff = authority?.staff;
  return ['prepared', 'committed'].includes(authority?.state)
    && staff?.redemptionId === redemptionId && staff.generation === current.generation
    && (staff.installationEpoch ?? null) === (current.installationEpoch ?? null);
};

const redeemStaffEnrolment = async ({ db, authUid, driverId, secret, capturedAuthority, nowMs = Date.now() }) => {
  if (typeof secret !== 'string' || !/^LLT1-[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw failure('STAFF_ENROLMENT_REQUIRED');
  }
  const secretHash = digest(secret);
  const redemptionId = digest(`${secretHash}:${authUid}`);
  // Audit evidence is pseudonymous: a delayed redemption cannot recreate a raw
  // installation UID after the account-deletion scan has already drained.
  const authUidHash = digest(authUid);
  const currentAuthority = capturedAuthority || await captureInstallationAuthority({ db, authUid });
  const policy = (await db.ref(`driver_staff_policy/${driverId}`).once('value')).val();
  if (policy?.schemaVersion !== 1 || typeof policy.generation !== 'string') throw failure('STAFF_ENROLMENT_INVALID');
  const result = await db.ref(`driver_enrolments/${secretHash}`).transaction(current => {
    if (current === null) return null; // cold cache is not absence
    if (current.schemaVersion !== 1 || current.driverId !== driverId || current.generation !== policy.generation
      || current.expiresAtMs <= nowMs || !['issued', 'redeemed'].includes(current.state)) return undefined;
    if (current.state === 'redeemed') {
      // The original operation may recover, but a logout/switch/replacement
      // changes its installation epoch and permanently supersedes this receipt.
      const recovery = receiptRecoveryMatches({ currentAuthority, redemptionId, current });
      if (current.authUidHash !== authUidHash || current.redemptionId !== redemptionId
        || ((current.installationEpoch ?? null) !== currentAuthority.epoch && !recovery)) return undefined;
      return current;
    }
    return { ...current, state: 'redeemed', authUidHash, redemptionId,
      installationEpoch: currentAuthority.epoch, redeemedAtMs: nowMs };
  }, undefined, false);
  const record = result.snapshot.val();
  if (!result.committed || record?.authUidHash !== authUidHash || record?.redemptionId !== redemptionId) {
    throw failure('STAFF_ENROLMENT_INVALID');
  }
  return { driverId, generation: record.generation, redemptionId, secretHash,
    installationEpoch: record.installationEpoch ?? null };
};

const verifyStaffSessionAuthority = async ({ db, authUid, session }) => {
  const [deviceSnapshot, policySnapshot, installationSnapshot] = await Promise.all([
    db.ref(`driver_device_authorizations/${authUid}`).once('value'),
    db.ref(`driver_staff_policy/${session.driverId}`).once('value'),
    db.ref(`app_session_authority/${authUid}`).once('value'),
  ]);
  const device = deviceSnapshot.val(); const policy = policySnapshot.val(); const installation = installationSnapshot.val();
  return device?.schemaVersion === 1 && device.state === 'active' && device.driverId === session.driverId
    && device.sessionId === session.sessionId && policy?.schemaVersion === 1
    && typeof policy.generation === 'string' && /^[a-f0-9]{48}$/.test(policy.generation)
    && device.generation === policy.generation && installation?.schemaVersion === 1
    && /^[a-f0-9]{48}$/.test(installation.epoch || '') && installation.state === 'committed'
    && installation.sessionId === session.sessionId;
};

module.exports = { ENROLMENT_TTL_MS, issueStaffEnrolment, revokeStaffEnrolment,
  redeemStaffEnrolment, verifyStaffSessionAuthority };
