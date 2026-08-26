import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import logger from '../loggerService';
import { initializeNotificationChannels, primeNotificationPermissions, registerForPushNotificationsAsync } from './notificationRegistrationService';
import { reconcileNotificationDevice } from './notificationDeviceApiService';

const RETRY_KEY = '@LLT:notification-registration-retry:v1';
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

export const createNotificationRegistrationCoordinator = ({
  storage = AsyncStorage,
  notificationApi = Notifications,
  reconcile = reconcileNotificationDevice,
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

  const clearRetry = async () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    await storage.removeItem(RETRY_KEY).catch(() => undefined);
  };
  const scheduleRetry = async (attempt) => {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(attempt, 5)));
    await storage.setItem(RETRY_KEY, JSON.stringify({ attempt, availableAtMs: now() + delay })).catch(() => undefined);
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
      const result = await reconcile({
        pushToken,
        permissionState: permissionData.state,
        permissionCanAskAgain: permissionData.canAskAgain === true,
        ...(snapshot.marketingPreferences ? { marketingPreferences: snapshot.marketingPreferences } : {}),
        operationalEligible: snapshot.operationalEligible === true,
        tourId: snapshot.tourId || null,
        appVersion: Constants.expoConfig?.version || null,
        appBuild: Constants.expoConfig?.ios?.buildNumber || Constants.expoConfig?.android?.versionCode?.toString() || null,
        platform: Platform.OS,
      });
      await clearRetry();
      return result;
    } catch (error) {
      // Do not retry an unavailable/blocked permission state: only network/service failures.
      if (permissionData.state !== 'blocked' && permissionData.state !== 'unavailable') {
        const retry = JSON.parse(await storage.getItem(RETRY_KEY).catch(() => null) || '{}');
        await scheduleRetry(Number(retry.attempt || 0) + 1);
      }
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
    if (changedIdentity) generation += 1;
    return reconcileCurrent('state_change');
  };
  const start = (initial) => {
    state = initial;
    generation += 1;
    initializeNotificationChannels().catch((error) => logger.warn('NotificationCoordinator', 'Android channel setup deferred', { error: error?.message || String(error) }));
    tokenSubscription = notificationApi.addPushTokenListener?.(() => reconcileCurrent('native_token_rotation')) || null;
    appStateSubscription = AppState.addEventListener?.('change', (nextState) => {
      if (nextState === 'active') reconcileCurrent('foreground');
    }) || null;
    storage.getItem(RETRY_KEY).then((raw) => {
      const retry = JSON.parse(raw || '{}');
      if (!retry.availableAtMs) return;
      if (retry.availableAtMs <= now()) reconcileCurrent('restored_retry');
      else retryTimer = setTimeout(() => reconcileCurrent('restored_retry'), retry.availableAtMs - now());
    }).catch(() => undefined);
    return reconcileCurrent('start');
  };
  const stop = () => {
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
