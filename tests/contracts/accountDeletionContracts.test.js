'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const definitions = require('../../contracts/definitions/contracts.v1.json');
const generated = require('../../functions/src/contracts/generated/contracts');
const focused = require('../../functions/src/contracts/generated/accountDeletion');
const mobileFocused = require('../../src/shared/contracts/generated/accountDeletion');

const RECEIPT = 'delrec_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SESSION_ID = 'sess_v1_0123456789abcdef0123456789abcdef';
const PHASES = [
  'reserved',
  'live_state_cleanup',
  'authority_release',
  'group_media',
  'private_media',
  'chat_scrub',
  'account_records',
  'auth_delete',
  'completed',
];

const validate = (name, value, options = {}) => generated.validateContract(name, value, options);

test('account-deletion receipt and safe phases are exact, typed, and bounded', () => {
  assert.equal(RECEIPT.length, 74);
  assert.equal(validate('AccountDeletionReceipt', RECEIPT).valid, true);
  assert.equal(validate('AccountDeletionReceipt', RECEIPT.toUpperCase()).valid, false);
  assert.equal(validate('AccountDeletionReceipt', 'delrec_v1_deadbeef').valid, false);
  assert.equal(validate('AccountDeletionReceipt', `delrec_v1_${'a'.repeat(65)}`).valid, false);

  for (const phase of PHASES) {
    assert.equal(validate('AccountDeletionSafePhase', phase).valid, true, phase);
  }
  for (const phase of ['queued', 'retrying', 'failed', 'server_only', 'compatibility']) {
    assert.equal(validate('AccountDeletionSafePhase', phase).valid, false, phase);
  }
});

test('public request, accepted response, and status request reject unknown or private fields', () => {
  const request = { expectedSessionId: SESSION_ID, deletionReceipt: RECEIPT, clientVersion: '1.2.3' };
  const accepted = {
    success: true,
    status: 'accepted',
    phase: 'reserved',
    retryable: true,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  };
  const statusRequest = { deletionReceipt: RECEIPT };

  assert.equal(validate('AccountDeletionRequest', request).valid, true);
  assert.equal(validate('AccountDeletionAcceptedResponse', accepted).valid, true);
  assert.equal(validate('AccountDeletionStatusRequest', statusRequest).valid, true);

  for (const [contract, value] of [
    ['AccountDeletionRequest', { ...request, authUid: 'private' }],
    ['AccountDeletionRequest', { ...request, expectedSessionId: 'session-guess' }],
    ['AccountDeletionAcceptedResponse', { ...accepted, deletionId: 'private' }],
    ['AccountDeletionAcceptedResponse', { ...accepted, status: 'pending' }],
    ['AccountDeletionStatusRequest', { ...statusRequest, expectedSessionId: SESSION_ID }],
  ]) {
    assert.equal(validate(contract, value).valid, false, contract);
  }
});

test('status and summary contracts expose only bounded aggregate progress', () => {
  const summary = {
    recordsRemoved: 12,
    storageObjectsRemoved: 3,
    chatMessagesScrubbed: 2,
    reactionsRemoved: 4,
  };
  const status = {
    success: true,
    status: 'completed',
    phase: 'completed',
    retryable: false,
    createdAtMs: 1000,
    updatedAtMs: 2000,
    completedAtMs: 2000,
    summary,
  };

  assert.equal(validate('AccountDeletionSafeSummary', summary).valid, true);
  assert.equal(validate('AccountDeletionStatusResponse', status).valid, true);

  for (const unsafe of [
    { ...summary, authUid: 'private' },
    { ...summary, bookingRef: 'T123456' },
    { ...summary, storagePath: 'private/file.jpg' },
    { ...summary, recordsRemoved: -1 },
    { ...summary, recordsRemoved: 1000001 },
  ]) {
    assert.equal(validate('AccountDeletionSafeSummary', unsafe).valid, false);
  }
  for (const unsafe of [
    { ...status, deletionReceipt: RECEIPT },
    { ...status, deletionId: 'private' },
    { ...status, status: 'failed' },
    { ...status, phase: 'retrying' },
  ]) {
    assert.equal(validate('AccountDeletionStatusResponse', unsafe).valid, false);
  }

  assert.equal(focused.validateAccountDeletionStatusResponse(status).valid, true);
  assert.equal(focused.validateAccountDeletionStatusResponse({
    ...status,
    summary: { ...summary, authUid: 'private' },
  }).valid, false);
  assert.deepEqual(
    focused.projectAccountDeletionStatusResponse({
      ...status,
      deletionId: 'private',
      summary: { ...summary, authUid: 'private' },
    }),
    status,
  );
});

test('pending local state is exact and excludes server identifiers and passenger data', () => {
  const pending = {
    schemaVersion: 2,
    state: 'requesting',
    deletionReceipt: RECEIPT,
    originalAuthUid: 'original_auth_uid-1',
    expectedSessionId: SESSION_ID,
    phase: 'reserved',
    retryable: true,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    requestAttempts: 0,
    statusAttempts: 0,
    localCleanupComplete: false,
    completionHandled: false,
  };
  assert.equal(validate('PendingAccountDeletionRecord', pending).valid, true);

  for (const forbiddenField of ['deletionId', 'authUid', 'bookingRef', 'email', 'phone', 'driverId', 'tourId']) {
    assert.equal(
      validate('PendingAccountDeletionRecord', { ...pending, [forbiddenField]: 'private' }).valid,
      false,
      forbiddenField,
    );
  }
  assert.equal(validate('PendingAccountDeletionRecord', { ...pending, state: 'unknown' }).valid, false);
  assert.equal(validate('PendingAccountDeletionRecord', { ...pending, phase: 'retrying' }).valid, false);
  assert.equal(validate('PendingAccountDeletionRecord', { ...pending, completedAtMs: 0 }).valid, false);
  assert.equal(validate('PendingAccountDeletionRecord', { ...pending, statusAttempts: 1001 }).valid, false);
  assert.equal(validate('PendingAccountDeletionRecord', { ...pending, originalAuthUid: 'contains/slash' }).valid, false);
  assert.equal(validate('PendingAccountDeletionRecord', { ...pending, originalAuthUid: 'x'.repeat(129) }).valid, false);
  const { originalAuthUid: _originalAuthUid, ...withoutOriginalAuthUid } = pending;
  assert.equal(validate('PendingAccountDeletionRecord', withoutOriginalAuthUid).valid, false);
  assert.equal(validate('PendingAccountDeletionRecord', { ...pending, schemaVersion: 1 }).valid, false);
  assert.equal(focused.validatePendingAccountDeletionRecord({ ...pending, state: 'pending' }).valid, false);
  const { expectedSessionId: _expectedSessionId, ...afterRequest } = pending;
  assert.equal(focused.validatePendingAccountDeletionRecord({ ...afterRequest, state: 'pending' }).valid, true);
});

test('rollout contract is private, exact, and fail-closed to known phases', () => {
  const contract = definitions.contracts.AccountDeletionRolloutRecord;
  assert.deepEqual(contract.requiredProperties, ['schemaVersion', 'phase', 'revision', 'updatedAtMs']);
  assert.deepEqual(contract.optionalProperties, []);
  assert.deepEqual(contract.enumValues.phase, ['compatibility', 'server_only']);
  assert.deepEqual(contract.safeClientProjection, []);

  const compatibility = { schemaVersion: 1, phase: 'compatibility', revision: 1, updatedAtMs: 1000 };
  assert.equal(validate('AccountDeletionRolloutRecord', compatibility, { clientProjection: false }).valid, true);
  assert.equal(validate('AccountDeletionRolloutRecord', { ...compatibility, phase: 'server_only' }, { clientProjection: false }).valid, true);
  assert.equal(validate('AccountDeletionRolloutRecord', { ...compatibility, phase: 'legacy' }, { clientProjection: false }).valid, false);
  assert.equal(validate('AccountDeletionRolloutRecord', { ...compatibility, revision: 0 }, { clientProjection: false }).valid, false);
  assert.equal(validate('AccountDeletionRolloutRecord', { ...compatibility, extra: true }, { clientProjection: false }).valid, false);
});

test('Functions and mobile expose the same generated account-deletion boundary helpers', () => {
  assert.deepEqual(Object.keys(mobileFocused).sort(), Object.keys(focused).sort());
  assert.deepEqual(
    mobileFocused.projectAccountDeletionStatusResponse({
      success: true,
      status: 'pending',
      phase: 'chat_scrub',
      retryable: true,
      deletionId: 'private',
    }),
    { success: true, status: 'pending', phase: 'chat_scrub', retryable: true },
  );
});
