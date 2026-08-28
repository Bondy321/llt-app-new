import { postAdminAction } from './adminActionService';

const normalizePolicy = (payload) => {
  const policy = payload?.policy;
  if (!policy || typeof policy.enforceSingleDevice !== 'boolean'
    || !Number.isSafeInteger(policy.generation) || policy.generation < 0
    || !Number.isSafeInteger(policy.revision) || policy.revision < 0
    || (policy.updatedAtMs !== null && (!Number.isSafeInteger(policy.updatedAtMs) || policy.updatedAtMs <= 0))) {
    throw new Error('The server returned an invalid driver login policy.');
  }
  return {
    enforceSingleDevice: policy.enforceSingleDevice,
    generation: policy.generation,
    revision: policy.revision,
    updatedAtMs: policy.updatedAtMs,
    isDefault: policy.isDefault === true,
  };
};

const normalizeCleanupCount = (value) => {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('The server returned invalid driver session cleanup progress.');
  }
  return value;
};

export async function getDriverLoginPolicy() {
  return normalizePolicy(await postAdminAction('getDriverLoginPolicy', {}, {
    fallbackError: 'Driver device settings could not be loaded.',
    reasonMessages: {
      POLICY_CONFIGURATION_INVALID: 'The saved driver device setting is invalid. Contact support before changing it.',
    },
  }));
}

export async function setDriverLoginPolicy({ enforceSingleDevice, expectedRevision }) {
  const payload = await postAdminAction('setDriverLoginPolicy', {
    enforceSingleDevice,
    expectedRevision,
  }, {
    fallbackError: 'Driver device settings could not be updated.',
    reasonMessages: {
      POLICY_CHANGED: 'This setting changed in another session. Refresh it and try again.',
      POLICY_CHANGE_IN_PROGRESS: 'Another driver device change is already in progress. Try again shortly.',
      TOO_MANY_DRIVER_SESSIONS: 'There are too many active driver sessions to enable this safely. Contact support.',
    },
  });
  return {
    policy: normalizePolicy(payload),
    changed: payload.changed === true,
    cleanup: {
      queued: normalizeCleanupCount(payload.cleanup?.queued),
      cleaned: normalizeCleanupCount(payload.cleanup?.cleaned),
      pending: normalizeCleanupCount(payload.cleanup?.pending),
    },
  };
}
