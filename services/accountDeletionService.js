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
const isPlainObject = (value) => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value);

export const validatePendingAccountDeletion = (input) => {
  if (!isPlainObject(input) || !validatePendingAccountDeletionRecord(input).valid) return null;
  if (input.updatedAtMs < input.createdAtMs) return null;
  if (input.state === 'requesting' && !SESSION_ID_PATTERN.test(input.expectedSessionId || '')) return null;
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
  try { return validatePendingAccountDeletion(JSON.parse(raw)); } catch { return null; }
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
  let statusInFlight = null;
  let completionInFlight = null;

  const writePending = async (record) => {
    const valid = validatePendingAccountDeletion(record);
    if (!valid) throw new Error('Account deletion recovery state is invalid.');
    await persistence.setItemAsync(ACCOUNT_DELETION_PENDING_KEY, JSON.stringify(valid));
    return valid;
  };

  const readPending = async () => {
    const raw = await persistence.getItemAsync(ACCOUNT_DELETION_PENDING_KEY);
    if (raw == null || raw === '') return null;
    const pending = parsePending(raw);
    if (!pending) {
      const error = new Error('Saved account deletion recovery state is invalid.');
      error.code = 'ACCOUNT_DELETION_RECOVERY_CORRUPT';
      throw error;
    }
    return pending;
  };

  const clearPending = () => persistence.deleteItemAsync(ACCOUNT_DELETION_PENDING_KEY);

  const post = async (functionName, body, { freshAuthOnFailure = false, freshAuthAttempted = false } = {}) => {
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
        return post(functionName, body, { freshAuthOnFailure: true, freshAuthAttempted: true });
      }
      const reason = typeof payload?.reason === 'string' && payload.reason.length <= 100
        ? payload.reason
        : 'ACCOUNT_DELETION_STATUS_UNAVAILABLE';
      return genericFailure(reason);
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

  const requestDeletion = async ({ expectedSessionId } = {}) => {
    if (requestInFlight) return requestInFlight;
    requestInFlight = (async () => {
      let pending = await readPending();
      if (pending && pending.state !== 'requesting') return pollStatus();
      if (!pending) {
        if (!SESSION_ID_PATTERN.test(expectedSessionId || '')) {
          return genericFailure('SESSION_REQUIRED');
        }
        const createdAtMs = now();
        pending = await writePending({
          schemaVersion: 1,
          deletionReceipt: generateReceipt(),
          state: 'requesting',
          expectedSessionId,
          createdAtMs,
          updatedAtMs: createdAtMs,
          requestAttempts: 0,
          statusAttempts: 0,
          localCleanupComplete: false,
          completionHandled: false,
        });
      }
      pending = await writePending({
        ...pending,
        requestAttempts: Math.min((pending.requestAttempts || 0) + 1, 1000),
        updatedAtMs: now(),
      });
      const response = await post('requestAccountDeletion', {
        expectedSessionId: pending.expectedSessionId,
        deletionReceipt: pending.deletionReceipt,
      });
      if (!response.success) {
        const reason = String(response.reason || 'ACCOUNT_DELETION_STATUS_UNAVAILABLE').slice(0, 80);
        pending = await writePending({ ...pending, lastErrorReason: reason, updatedAtMs: now() });
        return { ...response, pending };
      }
      return applyServerStatus(pending, response);
    })();
    try { return await requestInFlight; } finally { requestInFlight = null; }
  };

  const pollStatus = async () => {
    if (statusInFlight) return statusInFlight;
    statusInFlight = (async () => {
      const pending = await readPending();
      if (!pending) return genericFailure('NO_PENDING_DELETION');
      if (pending.state === 'requesting') {
        return requestDeletion({ expectedSessionId: pending.expectedSessionId });
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
    if (pending.state === 'requesting') return requestDeletion({ expectedSessionId: pending.expectedSessionId });
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

  const markLocalCleanupComplete = async () => {
    const pending = await readPending();
    if (!pending) return null;
    return writePending({ ...pending, localCleanupComplete: true, updatedAtMs: now() });
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
      if (pending.state !== 'completed' || pending.localCleanupComplete !== true) {
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
  validatePendingAccountDeletion,
};

export default {
  ACCOUNT_DELETION_PENDING_KEY,
  DATA_REQUEST_EMAIL,
  PRIVACY_POLICY_URL,
  ...accountDeletionService,
};
