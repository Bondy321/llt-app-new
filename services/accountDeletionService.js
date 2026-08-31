import { auth, authHelpers, getCurrentAppCheckToken } from '../firebase';
import {
  projectAccountDeletionAcceptedResponse,
  projectAccountDeletionStatusResponse,
  projectPendingAccountDeletionRecord,
  validateAccountDeletionAcceptedResponse,
  validateAccountDeletionStatusResponse,
  validatePendingAccountDeletionRecord,
} from '../src/shared/contracts/generated/accountDeletion';
import { createPersistenceProvider } from './persistenceProvider';

export const PRIVACY_POLICY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim()
  || 'https://lochlomondtravel.com/images/pdfs/Loch_Lomond_Travel_App_Privacy_Policy.pdf';

export const DATA_REQUEST_EMAIL =
  process.env.EXPO_PUBLIC_DATA_REQUEST_EMAIL?.trim()
  || 'support@lochlomondtravel.com';

export const ACCOUNT_DELETION_PENDING_KEY = 'pending_v1';

const SESSION_ID_PATTERN = /^sess_v1_[a-f0-9]{32}$/u;
const ORIGINAL_AUTH_UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const isPlainObject = (value) => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value);

export const normalizeOriginalAuthUid = (value) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return ORIGINAL_AUTH_UID_PATTERN.test(normalized) ? normalized : null;
};

export const validatePendingAccountDeletion = (input) => {
  if (!isPlainObject(input) || !validatePendingAccountDeletionRecord(input).valid) return null;
  if (input.updatedAtMs < input.createdAtMs) return null;
  if (input.state === 'requesting' && !SESSION_ID_PATTERN.test(input.expectedSessionId || '')) return null;
  if ((input.localCleanupState === 'complete') !== (input.localCleanupComplete === true)) return null;
  if (input.state === 'completed'
    && (input.phase !== 'completed'
      || !Number.isSafeInteger(input.completedAtMs)
      || input.completedAtMs < input.createdAtMs)) return null;
  return projectPendingAccountDeletionRecord(input);
};

export const validateAccountDeletionResponse = (input) => {
  if (!isPlainObject(input)) return null;
  const validation = input.status === 'accepted'
    ? validateAccountDeletionAcceptedResponse(input)
    : validateAccountDeletionStatusResponse(input);
  if (!validation.valid) return null;
  if (input.status === 'completed'
    && (input.phase !== 'completed' || !Number.isSafeInteger(input.completedAtMs))) return null;
  return input.status === 'accepted'
    ? projectAccountDeletionAcceptedResponse(input)
    : projectAccountDeletionStatusResponse(input);
};

export const generateDeletionReceipt = ({ cryptoObject = globalThis.crypto } = {}) => {
  if (!cryptoObject || typeof cryptoObject.getRandomValues !== 'function') {
    const error = new Error('Secure random generation is unavailable on this device.');
    error.code = 'SECURE_RANDOM_UNAVAILABLE';
    throw error;
  }
  const bytes = new Uint8Array(32);
  cryptoObject.getRandomValues(bytes);
  return `delrec_v1_${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
};

const buildEndpoint = (functionName) => {
  const overrides = {
    requestAccountDeletion: process.env.EXPO_PUBLIC_REQUEST_ACCOUNT_DELETION_URL,
    getAccountDeletionStatus: process.env.EXPO_PUBLIC_ACCOUNT_DELETION_STATUS_URL,
    retryAccountDeletion: process.env.EXPO_PUBLIC_RETRY_ACCOUNT_DELETION_URL,
  };
  const override = overrides[functionName]?.trim();
  if (override) return override;
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  return projectId
    ? `https://europe-west1-${projectId}.cloudfunctions.net/${functionName}`
    : null;
};

const createDefaultPersistence = () => createPersistenceProvider({
  namespace: 'LLT_ACCOUNT_DELETION',
  preferredStorage: 'secure-store',
  migrateFrom: ['async-storage'],
  allowMemoryFallback: process.env.NODE_ENV === 'test',
});

const parsePending = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    const candidate = parsed?.schemaVersion === 2
      && !Object.prototype.hasOwnProperty.call(parsed, 'localCleanupState')
      ? {
          ...parsed,
          schemaVersion: 3,
          localCleanupState: parsed.localCleanupComplete === true ? 'complete' : 'not_started',
        }
      : parsed;
    return validatePendingAccountDeletion(candidate);
  } catch { return null; }
};

const genericFailure = (reason = 'ACCOUNT_DELETION_STATUS_UNAVAILABLE') => ({
  success: false,
  reason,
  error: reason === 'NETWORK_ERROR'
    ? 'We cannot reach account services yet. Your deletion request is still saved on this device.'
    : 'We could not confirm account deletion status. Please try again.',
});

export const createAccountDeletionService = ({
  persistence = createDefaultPersistence(),
  fetchFn = (...args) => fetch(...args),
  now = () => Date.now(),
  generateReceipt = () => generateDeletionReceipt(),
  getFirebase = () => ({ auth, authHelpers, getCurrentAppCheckToken }),
} = {}) => {
  let requestInFlight = null;
  let reservationInFlight = null;
  let statusInFlight = null;
  let completionInFlight = null;
  let pendingWriteTail = Promise.resolve();

  const localCleanupRank = (state) => ({ not_started: 0, commit_prepared: 1, complete: 2 }[state] ?? -1);

  const writePending = (record) => {
    const operation = pendingWriteTail.catch(() => {}).then(async () => {
      let valid = validatePendingAccountDeletion(record);
      if (!valid) throw new Error('Account deletion recovery state is invalid.');
      const currentRaw = await persistence.getItemAsync(ACCOUNT_DELETION_PENDING_KEY);
      const current = parsePending(currentRaw);
      if (current?.deletionReceipt === valid.deletionReceipt) {
        if (localCleanupRank(current.localCleanupState) > localCleanupRank(valid.localCleanupState)) {
          valid = validatePendingAccountDeletion({
            ...valid,
            localCleanupState: current.localCleanupState,
            localCleanupComplete: current.localCleanupComplete,
          });
        }
        if (current.completionHandled && !valid.completionHandled) {
          valid = validatePendingAccountDeletion({ ...valid, completionHandled: true });
        }
      }
      if (!valid) throw new Error('Account deletion recovery state is invalid.');
      await persistence.setItemAsync(ACCOUNT_DELETION_PENDING_KEY, JSON.stringify(valid));
      return valid;
    });
    pendingWriteTail = operation.catch(() => {});
    return operation;
  };

  const readPending = async () => {
    await pendingWriteTail.catch(() => {});
    const raw = await persistence.getItemAsync(ACCOUNT_DELETION_PENDING_KEY);
    if (raw == null || raw === '') return null;
    const pending = parsePending(raw);
    if (!pending) {
      const error = new Error('Saved account deletion recovery state is invalid.');
      error.code = 'ACCOUNT_DELETION_RECOVERY_CORRUPT';
      throw error;
    }
    const persisted = JSON.parse(raw);
    if (persisted.schemaVersion !== pending.schemaVersion) {
      return writePending(pending);
    }
    return pending;
  };

  const clearPending = () => persistence.deleteItemAsync(ACCOUNT_DELETION_PENDING_KEY);

  const post = async (functionName, body, {
    expectedAuthUid = null,
    freshAuthOnFailure = false,
    freshAuthAttempted = false,
  } = {}) => {
    const firebase = getFirebase();
    const endpoint = buildEndpoint(functionName);
    if (!endpoint) return genericFailure('ENDPOINT_UNAVAILABLE');
    let currentUser;
    let token;
    try {
      currentUser = firebase.auth?.currentUser || null;
      if (!currentUser && freshAuthOnFailure) {
        currentUser = await firebase.authHelpers?.replaceWithFreshAnonymous?.();
      }
      if (!currentUser?.getIdToken) return genericFailure('AUTH_UNAVAILABLE');
      if (expectedAuthUid && currentUser.uid !== expectedAuthUid) {
        return genericFailure('AUTH_UNAVAILABLE');
      }
      token = await currentUser.getIdToken();
    } catch {
      if (!freshAuthOnFailure) return genericFailure('AUTH_UNAVAILABLE');
      try {
        currentUser = await firebase.authHelpers?.replaceWithFreshAnonymous?.();
        token = await currentUser?.getIdToken?.();
      } catch {
        return genericFailure('AUTH_UNAVAILABLE');
      }
    }
    if (!token) return genericFailure('AUTH_UNAVAILABLE');
    const appCheckToken = await firebase.getCurrentAppCheckToken?.();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    if (appCheckToken) headers['x-firebase-appcheck'] = appCheckToken;
    let response;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      return genericFailure('NETWORK_ERROR');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && freshAuthOnFailure && !freshAuthAttempted) {
        try {
          await firebase.authHelpers?.replaceWithFreshAnonymous?.();
        } catch {
          return genericFailure('AUTH_UNAVAILABLE');
        }
        return post(functionName, body, {
          expectedAuthUid,
          freshAuthOnFailure: true,
          freshAuthAttempted: true,
        });
      }
      const reason = typeof payload?.reason === 'string' && payload.reason.length <= 100
        ? payload.reason
        : 'ACCOUNT_DELETION_STATUS_UNAVAILABLE';
      return {
        ...genericFailure(reason),
        httpStatus: response.status,
        confirmedStatusUnavailable: response.status === 404
          && payload?.reason === 'ACCOUNT_DELETION_STATUS_UNAVAILABLE',
      };
    }
    const valid = validateAccountDeletionResponse(payload);
    return valid || genericFailure('INVALID_SERVER_RESPONSE');
  };

  const applyServerStatus = async (pending, response) => {
    if (!response?.success) return response;
    const updatedAtMs = now();
    const updatedRecord = {
      ...pending,
      state: response.status,
      phase: response.phase,
      retryable: response.retryable,
      updatedAtMs,
      lastCheckedAtMs: updatedAtMs,
    };
    delete updatedRecord.expectedSessionId;
    delete updatedRecord.lastErrorReason;
    if (response.completedAtMs !== undefined) updatedRecord.completedAtMs = response.completedAtMs;
    else delete updatedRecord.completedAtMs;
    if (response.summary !== undefined) updatedRecord.summary = response.summary;
    else delete updatedRecord.summary;
    const updated = await writePending(updatedRecord);
    return { ...response, pending: updated };
  };

  const submitInitialRequest = async (pending) => {
    if (reservationInFlight) return reservationInFlight;
    reservationInFlight = (async () => {
      const requesting = await writePending({
        ...pending,
        requestAttempts: Math.min((pending.requestAttempts || 0) + 1, 1000),
        updatedAtMs: now(),
      });
      const response = await post('requestAccountDeletion', {
        expectedSessionId: requesting.expectedSessionId,
        deletionReceipt: requesting.deletionReceipt,
      }, { expectedAuthUid: requesting.originalAuthUid });
      if (!response.success) {
        const reason = String(response.reason || 'ACCOUNT_DELETION_STATUS_UNAVAILABLE').slice(0, 80);
        const failed = await writePending({ ...requesting, lastErrorReason: reason, updatedAtMs: now() });
        return { ...response, pending: failed };
      }
      return applyServerStatus(requesting, response);
    })();
    try { return await reservationInFlight; } finally { reservationInFlight = null; }
  };

  const reconcileRequesting = async (pending) => {
    const checkedAtMs = now();
    const checking = await writePending({
      ...pending,
      statusAttempts: Math.min((pending.statusAttempts || 0) + 1, 1000),
      lastCheckedAtMs: checkedAtMs,
      updatedAtMs: checkedAtMs,
    });
    const response = await post('getAccountDeletionStatus', {
      deletionReceipt: checking.deletionReceipt,
    }, { freshAuthOnFailure: true });
    if (response.success) return applyServerStatus(checking, response);

    const reason = String(response.reason || 'ACCOUNT_DELETION_STATUS_UNAVAILABLE').slice(0, 80);
    const failed = await writePending({
      ...checking,
      state: 'requesting',
      lastErrorReason: reason,
      updatedAtMs: now(),
    });
    if (response.confirmedStatusUnavailable !== true) {
      return { ...response, pending: failed };
    }

    const currentAuthUid = normalizeOriginalAuthUid(getFirebase()?.auth?.currentUser?.uid);
    if (currentAuthUid !== failed.originalAuthUid) {
      return { ...response, pending: failed };
    }
    return submitInitialRequest(failed);
  };

  const requestDeletion = async ({ expectedSessionId } = {}) => {
    if (requestInFlight) return requestInFlight;
    requestInFlight = (async () => {
      let pending = await readPending();
      if (pending) return pollStatus();
      if (!pending) {
        if (!SESSION_ID_PATTERN.test(expectedSessionId || '')) {
          return genericFailure('SESSION_REQUIRED');
        }
        const originalAuthUid = normalizeOriginalAuthUid(getFirebase()?.auth?.currentUser?.uid);
        if (!originalAuthUid) return genericFailure('AUTH_UNAVAILABLE');
        const createdAtMs = now();
        pending = await writePending({
          schemaVersion: 3,
          deletionReceipt: generateReceipt(),
          originalAuthUid,
          state: 'requesting',
          expectedSessionId,
          createdAtMs,
          updatedAtMs: createdAtMs,
          requestAttempts: 0,
          statusAttempts: 0,
          localCleanupState: 'not_started',
          localCleanupComplete: false,
          completionHandled: false,
        });
      }
      return submitInitialRequest(pending);
    })();
    try { return await requestInFlight; } finally { requestInFlight = null; }
  };

  const pollStatus = async () => {
    if (reservationInFlight) return reservationInFlight;
    if (statusInFlight) return statusInFlight;
    statusInFlight = (async () => {
      const pending = await readPending();
      if (!pending) return genericFailure('NO_PENDING_DELETION');
      if (pending.state === 'requesting') {
        return reconcileRequesting(pending);
      }
      const checkedAtMs = now();
      const checking = await writePending({
        ...pending,
        statusAttempts: Math.min((pending.statusAttempts || 0) + 1, 1000),
        lastCheckedAtMs: checkedAtMs,
        updatedAtMs: checkedAtMs,
      });
      const response = await post('getAccountDeletionStatus', {
        deletionReceipt: checking.deletionReceipt,
      }, { freshAuthOnFailure: true });
      if (!response.success) {
        const reason = String(response.reason || 'ACCOUNT_DELETION_STATUS_UNAVAILABLE').slice(0, 80);
        const failed = await writePending({
          ...checking,
          state: response.reason === 'NETWORK_ERROR' ? 'waiting_for_connection' : checking.state,
          lastErrorReason: reason,
          updatedAtMs: now(),
        });
        return { ...response, pending: failed };
      }
      return applyServerStatus(checking, response);
    })();
    try { return await statusInFlight; } finally { statusInFlight = null; }
  };

  const retryDeletion = async () => {
    const pending = await readPending();
    if (!pending) return genericFailure('NO_PENDING_DELETION');
    if (pending.state === 'requesting') return pollStatus();
    const checkedAtMs = now();
    const checking = await writePending({
      ...pending,
      statusAttempts: Math.min((pending.statusAttempts || 0) + 1, 1000),
      lastCheckedAtMs: checkedAtMs,
      updatedAtMs: checkedAtMs,
    });
    const response = await post('retryAccountDeletion', {
      deletionReceipt: checking.deletionReceipt,
    }, { freshAuthOnFailure: true });
    if (!response.success) {
      const reason = String(response.reason || 'ACCOUNT_DELETION_STATUS_UNAVAILABLE').slice(0, 80);
      const failed = await writePending({
        ...checking,
        state: response.reason === 'NETWORK_ERROR' ? 'waiting_for_connection' : checking.state,
        lastErrorReason: reason,
        updatedAtMs: now(),
      });
      return { ...response, pending: failed };
    }
    return applyServerStatus(checking, response);
  };

  const markLocalCleanupCommitPrepared = async () => {
    const pending = await readPending();
    if (!pending) return null;
    if (pending.localCleanupState === 'complete' || pending.localCleanupState === 'commit_prepared') {
      return pending;
    }
    return writePending({
      ...pending,
      localCleanupState: 'commit_prepared',
      localCleanupComplete: false,
      updatedAtMs: now(),
    });
  };

  const markLocalCleanupComplete = async () => {
    const pending = await readPending();
    if (!pending) return null;
    if (pending.localCleanupState !== 'commit_prepared' && pending.localCleanupState !== 'complete') {
      const error = new Error('Local cleanup commit has not been prepared.');
      error.code = 'LOCAL_CLEANUP_NOT_PREPARED';
      throw error;
    }
    return writePending({
      ...pending,
      localCleanupState: 'complete',
      localCleanupComplete: true,
      updatedAtMs: now(),
    });
  };

  const markCompletionHandled = async () => {
    const pending = await readPending();
    if (!pending || pending.state !== 'completed') return null;
    return writePending({ ...pending, completionHandled: true, updatedAtMs: now() });
  };

  const finalizeCompletedRecovery = async () => {
    if (completionInFlight) return completionInFlight;
    completionInFlight = (async () => {
      let pending = await readPending();
      if (!pending) return { success: true, alreadyComplete: true, pending: null };
      if (pending.state !== 'completed'
        || pending.localCleanupState !== 'complete'
        || pending.localCleanupComplete !== true) {
        return { success: false, reason: 'LOCAL_CLEANUP_REQUIRED', pending };
      }
      if (!pending.completionHandled) pending = await markCompletionHandled();
      await clearPending();
      return { success: true, pending };
    })();
    try { return await completionInFlight; } finally { completionInFlight = null; }
  };

  return {
    clearPending,
    finalizeCompletedRecovery,
    markCompletionHandled,
    markLocalCleanupCommitPrepared,
    markLocalCleanupComplete,
    pollStatus,
    readPending,
    requestDeletion,
    retryDeletion,
    writePending,
  };
};

const accountDeletionService = createAccountDeletionService();

// Compatibility export for the screen boundary. The result now represents
// durable server acceptance, never handset-coordinated completion.
export const deleteCurrentAccount = ({ appSession } = {}) => accountDeletionService.requestDeletion({
  expectedSessionId: appSession?.sessionId || null,
});

export const __accountDeletionTestables = {
  validateAccountDeletionResponse,
  normalizeOriginalAuthUid,
  validatePendingAccountDeletion,
};

export default {
  ACCOUNT_DELETION_PENDING_KEY,
  DATA_REQUEST_EMAIL,
  PRIVACY_POLICY_URL,
  ...accountDeletionService,
};
