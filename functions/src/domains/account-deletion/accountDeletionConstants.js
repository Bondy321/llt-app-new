'use strict';

// @ts-check

const ACCOUNT_DELETION_JOB_ROOT = 'account_deletion_jobs/v1';
const ACCOUNT_DELETION_QUEUE_ROOT = 'account_deletion_queue/v1';
const ACCOUNT_DELETION_ACTIVE_ROOT = 'account_deletion_active/v1';
const ACCOUNT_DELETION_COMPLETION_TOMBSTONE_ROOT = 'account_deletion_completion_tombstones/v1';
const ACCOUNT_DELETION_LOCK_ROOT = 'account_deletion_locks/v1';
const ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT = 'account_deletion_passenger_active/v1';
const ACCOUNT_DELETION_PASSENGER_LOCK_ROOT = 'account_deletion_passenger_locks/v1';
const ACCOUNT_DELETION_ROLLOUT_PATH = 'account_deletion_rollout/v1';
const ACCOUNT_DELETION_UID_TOMBSTONE_ROOT = 'account_deletion_uid_tombstones/v1';

const ACCOUNT_DELETION_PHASES = Object.freeze([
  'reserved',
  'live_state_cleanup',
  'authority_release',
  'group_media',
  'private_media',
  'chat_scrub',
  'account_records',
  'auth_delete',
  'completed',
]);
const ACCOUNT_DELETION_PHASE_SET = new Set(ACCOUNT_DELETION_PHASES);
const ACCOUNT_DELETION_RECEIPT_PATTERN = /^delrec_v1_[a-f0-9]{64}$/;
const ACCOUNT_DELETION_ID_PATTERN = /^acctdel_v1_[a-f0-9]{64}$/;
const ACCOUNT_DELETION_LEASE_MS = 5 * 60 * 1000;
const ACCOUNT_DELETION_COMPLETION_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const ACCOUNT_DELETION_MEDIA_PAGE_SIZE = 20;
const ACCOUNT_DELETION_CHAT_PAGE_SIZE = 50;
const ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES = 8;

const emptyAccountDeletionSummary = () => ({
  recordsRemoved: 0,
  storageObjectsRemoved: 0,
  chatMessagesScrubbed: 0,
  reactionsRemoved: 0,
});

module.exports = {
  ACCOUNT_DELETION_ACTIVE_ROOT,
  ACCOUNT_DELETION_CHAT_PAGE_SIZE,
  ACCOUNT_DELETION_COMPLETION_TOMBSTONE_ROOT,
  ACCOUNT_DELETION_COMPLETION_RETENTION_MS,
  ACCOUNT_DELETION_ID_PATTERN,
  ACCOUNT_DELETION_JOB_ROOT,
  ACCOUNT_DELETION_LOCK_ROOT,
  ACCOUNT_DELETION_LEASE_MS,
  ACCOUNT_DELETION_MAX_CONSECUTIVE_FAILURES,
  ACCOUNT_DELETION_MEDIA_PAGE_SIZE,
  ACCOUNT_DELETION_PASSENGER_ACTIVE_ROOT,
  ACCOUNT_DELETION_PASSENGER_LOCK_ROOT,
  ACCOUNT_DELETION_PHASES,
  ACCOUNT_DELETION_PHASE_SET,
  ACCOUNT_DELETION_QUEUE_ROOT,
  ACCOUNT_DELETION_RECEIPT_PATTERN,
  ACCOUNT_DELETION_ROLLOUT_PATH,
  ACCOUNT_DELETION_UID_TOMBSTONE_ROOT,
  emptyAccountDeletionSummary,
};
