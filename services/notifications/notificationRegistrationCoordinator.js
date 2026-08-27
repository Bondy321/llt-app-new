import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import logger from '../loggerService';
import { initializeNotificationChannels, primeNotificationPermissions, registerForPushNotificationsAsync } from './notificationRegistrationService';
import { reconcileNotificationDevice } from './notificationDeviceApiService';
import { allocateNotificationRegistrationRevision } from './notificationRegistrationRevision';

const RETRY_KEY_PREFIX = '@LLT:notification-registration-retry:v2:';
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

export const createNotificationRegistrationCoordinator = ({
  storage = AsyncStorage,
  notificationApi = Notifications,
  reconcile = reconcileNotificationDevice,
  allocateRevision = allocateNotificationRegistrationRevision,
  now = () => Date.now(),
} = {}) => {
  let state = null;
  let generation = 0;
  let inFlight = null;
  let pendingReason = null;
  let inFlightState = null;
  let inFlightGeneration = null;
  let retryTimer = null;
  let tokenSubscription = null;
  let appStateSubscription = null;
  let active = false;

  const retryKey = (snapshot) => {
    const authUid = typeof snapshot?.authUid === 'string' ? snapshot.authUid.replace(/[^A-Za-z0-9_-]/g, '_') : 'anonymous';
    const sessionId = typeof snapshot?.sessionId === 'string' ? snapshot.sessionId.replace(/[^A-Za-z0-9_-]/g, '_') : 'marketing';
    return `${RETRY_KEY_PREFIX}${authUid}:${sessionId}`;
  };

  const clearRetry = async (snapshot, callGeneration) => {
    if (!active || callGeneration !== generation) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    await storage.removeItem(retryKey(snapshot)).catch(() => undefined);
  };
  const scheduleRetry = async (snapshot, callGeneration, attempt) => {
    if (!active || callGeneration !== generation || snapshot !== state) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(attempt, 5)));
    const key = retryKey(snapshot);
    await storage.setItem(key, JSON.stringify({
      attempt,
      availableAtMs: now() + delay,
      authUid: snapshot.authUid,
      sessionId: snapshot.sessionId || null,
    })).catch(() => undefined);
    if (!active || callGeneration !== generation || snapshot !== state) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => reconcileCurrent('durable_retry'), delay);
  };
  const permissionState = async () => primeNotificationPermissions({
    userId: null, requestIfNeeded: false, persistState: false,
  });
  const reconcileOnce = async (reason = 'manual') => {
    const snapshot = state;
    const callGeneration = generation;
    if (!snapshot?.authUid || !snapshot?.isConnected) return { skipped: true, reason: 'not_ready' };
    const permission = await permissionState();
    if (callGeneration !== generation || snapshot !== state) return { skipped: true, reason: 'stale' };
    const permissionData = permission?.data || { state: 'unavailable', granted: false, canAskAgain: false };
    const pushToken = permissionData.granted
      ? await registerForPushNotificationsAsync(1, { permissionGranted: true, requestIfNeeded: false })
      : null;
    if (callGeneration !== generation || snapshot !== state) return { skipped: true, reason: 'stale' };
    try {
      if (permissionData.granted && !pushToken) {
        const tokenError = new Error('Expo push token is temporarily unavailable');
        tokenError.code = 'TOKEN_FETCH_FAILED';
        throw tokenError;
      }
      const operationalEligible = snapshot.operationalEligible === true
        && typeof snapshot.sessionId === 'string'
        && Number.isSafeInteger(snapshot.sessionRevision)
        && snapshot.sessionRevision > 0
        && typeof snapshot.tourId === 'string';
      const registrationRevision = await allocateRevision({ authUid: snapshot.authUid, now });
      if (!active || callGeneration !== generation || snapshot !== state) return { skipped: true, reason: 'stale' };
      const result = await reconcile({
        pushToken,
        permissionState: permissionData.state,
        permissionCanAskAgain: permissionData.canAskAgain === true,
        ...(snapshot.marketingPreferences ? { marketingPreferences: snapshot.marketingPreferences } : {}),
        operationalEligible,
        tourId: snapshot.tourId || null,
        ...(operationalEligible ? {
          appSessionId: snapshot.sessionId,
          appSessionRevision: snapshot.sessionRevision,
        } : {}),
        registrationRevision,
        appVersion: Constants.expoConfig?.version || null,
        appBuild: Constants.expoConfig?.ios?.buildNumber || Constants.expoConfig?.android?.versionCode?.toString() || null,
        platform: Platform.OS,
      });
      if (!active || callGeneration !== generation || snapshot !== state) return { skipped: true, reason: 'stale' };
      await clearRetry(snapshot, callGeneration);
      return result;
    } catch (error) {
      if (!active || callGeneration !== generation || snapshot !== state) return { skipped: true, reason: 'stale' };
      // Permission decisions are not re-prompted, but publishing a disabled
      // state is still durable and must retry after transport/service failure.
      const retry = JSON.parse(await storage.getItem(retryKey(snapshot)).catch(() => null) || '{}');
      await scheduleRetry(snapshot, callGeneration, Number(retry.attempt || 0) + 1);
      logger.warn('NotificationCoordinator', 'Notification registration reconciliation deferred', {
        reason, error: error?.message || String(error),
      });
      return { success: false, error: error?.message || String(error) };
    }
  };
  const reconcileCurrent = async (reason = 'manual') => {
    if (!state?.authUid || !state?.isConnected) return { skipped: true, reason: 'not_ready' };
    if (inFlight) {
      if (state !== inFlightState
        || generation !== inFlightGeneration
        || reason === 'native_token_rotation') {
        pendingReason = reason;
      }
      return inFlight;
    }
    inFlight = (async () => {
      let nextReason = reason;
      let result;
      do {
        pendingReason = null;
        inFlightState = state;
        inFlightGeneration = generation;
        result = await reconcileOnce(nextReason);
        nextReason = pendingReason;
      } while (nextReason && state?.authUid && state?.isConnected);
      return result;
    })().finally(() => {
      inFlight = null;
      inFlightState = null;
      inFlightGeneration = null;
    });
    return inFlight;
  };
  const update = (next) => {
    const changedIdentity = next?.authUid !== state?.authUid || next?.sessionId !== state?.sessionId;
    state = next;
    if (changedIdentity) {
      generation += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    }
    return reconcileCurrent('state_change');
  };
  const start = (initial) => {
    active = true;
    state = initial;
    generation += 1;
    initializeNotificationChannels().catch((error) => logger.warn('NotificationCoordinator', 'Android channel setup deferred', { error: error?.message || String(error) }));
    tokenSubscription = notificationApi.addPushTokenListener?.(() => reconcileCurrent('native_token_rotation')) || null;
    appStateSubscription = AppState.addEventListener?.('change', (nextState) => {
      if (nextState === 'active') reconcileCurrent('foreground');
    }) || null;
    const initialGeneration = generation;
    const initialState = state;
    storage.getItem(retryKey(initialState)).then((raw) => {
      const retry = JSON.parse(raw || '{}');
      if (!active || initialGeneration !== generation || initialState !== state || !retry.availableAtMs) return;
      if (retry.availableAtMs <= now()) reconcileCurrent('restored_retry');
      else retryTimer = setTimeout(() => reconcileCurrent('restored_retry'), retry.availableAtMs - now());
    }).catch(() => undefined);
    return reconcileCurrent('start');
  };
  const stop = () => {
    active = false;
    generation += 1;
    state = null;
    pendingReason = null;
    inFlightState = null;
    inFlightGeneration = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    tokenSubscription?.remove?.(); tokenSubscription = null;
    appStateSubscription?.remove?.(); appStateSubscription = null;
  };
  return { start, stop, update, reconcile: reconcileCurrent };
};
