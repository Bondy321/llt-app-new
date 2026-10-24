'use strict';

const { derivePassengerAccountDeletionKey } = require('./accountDeletionBoundary');

const {
  acquirePassengerAccountDeletionLock,
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
  readActiveAccountDeletion,
  readActivePassengerAccountDeletion,
  releasePassengerAccountDeletionLock,
  renewPassengerAccountDeletionLock,
} = require('./accountDeletionCoordination');

module.exports = {
  derivePassengerAccountDeletionKey,
  acquirePassengerAccountDeletionLock,
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
  readActiveAccountDeletion,
  readActivePassengerAccountDeletion,
  releasePassengerAccountDeletionLock,
  renewPassengerAccountDeletionLock,
};
