import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState, Platform } from 'react-native';
import { auth, realtimeDb } from '../../firebase';
import appSessionService from '../appSessionService';
import { publishDriverLocation, withdrawLiveDriverLocation } from '../driverLocationService';
import { createDriverTrackingController } from './createDriverTrackingController';
import { createTrackingRestRepository } from './trackingRestRepository';
import { TRACKING_TASK_NAME, TRACKING_INTERVAL_MS } from './trackingIntent';
import { withTrackingTimeout } from './withTrackingTimeout';

const granted = result => result?.status === 'granted';
const native = {
  isForeground: () => AppState.currentState === 'active',
  isStarted: () => Platform.OS === 'web' ? Promise.resolve(false) : Location.hasStartedLocationUpdatesAsync(TRACKING_TASK_NAME),
  hasPermissions: async () => await Location.hasServicesEnabledAsync()
    && granted(await Location.getForegroundPermissionsAsync())
    && (Platform.OS !== 'ios' || granted(await Location.getBackgroundPermissionsAsync())),
  requestPermissions: async () => {
    if (Platform.OS === 'web' || !await TaskManager.isAvailableAsync()) throw new Error('NATIVE_BUILD_REQUIRED');
    if (!await Location.hasServicesEnabledAsync()) throw new Error('LOCATION_SERVICES_DISABLED');
    if (!granted(await Location.requestForegroundPermissionsAsync())) throw new Error('FOREGROUND_PERMISSION_REQUIRED');
    // SDK55's user-initiated Android foreground service uses foreground access.
    // Never request Android background access or restart a service headlessly.
    if (Platform.OS === 'ios' && !granted(await Location.requestBackgroundPermissionsAsync())) {
      throw new Error('ALWAYS_PERMISSION_REQUIRED');
    }
  },
  start: async () => {
    if (!native.isForeground()) throw new Error('START_INTERRUPTED');
    await Location.startLocationUpdatesAsync(TRACKING_TASK_NAME, {
      accuracy: Location.Accuracy.High, timeInterval: TRACKING_INTERVAL_MS, distanceInterval: 0,
      deferredUpdatesInterval: TRACKING_INTERVAL_MS, deferredUpdatesDistance: 0,
      showsBackgroundLocationIndicator: true, pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation,
      ...(Platform.OS === 'android' ? { foregroundService: {
        notificationTitle: 'LLT coach tracking', notificationBody: 'Location sharing is on. Open LLT to stop tracking.',
        notificationColor: '#007DC3', killServiceOnDestroy: true,
      } } : {}),
    });
  },
  stop: async () => { if (await native.isStarted()) await Location.stopLocationUpdatesAsync(TRACKING_TASK_NAME); },
  permissionMessage: error => ({
    NATIVE_BUILD_REQUIRED: 'Tracking needs the updated iOS or Android app. It is unavailable in Expo Go or the browser.',
    LOCATION_SERVICES_DISABLED: 'Turn on device location services, then start tracking again.',
    FOREGROUND_PERMISSION_REQUIRED: 'Location permission is needed to track this coach. Allow it in device settings, then try again.',
    ALWAYS_PERMISSION_REQUIRED: 'Allow Always location access in iPhone Settings for tracking while the phone is locked.',
    START_INTERRUPTED: 'Tracking did not start because the app, driver session or assignment changed.',
  }[error?.message] || 'Tracking could not start. Check your connection and driver session, then try again.'),
};

const transport = createTrackingRestRepository({ database: realtimeDb, auth,
  baseUrl: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL || '',
  retireEndpoint: process.env.EXPO_PUBLIC_DRIVER_TRACKING_STOP_URL?.trim()
    || (process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID
      ? `https://europe-west1-${process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID}.cloudfunctions.net/stopDriverTrackingSession` : ''),
});
const verifyAuthority = async scope => {
  try { await withTrackingTimeout(() => auth?.authStateReady?.()); }
  catch { return { valid: false, reason: 'OFFLINE' }; }
  if (auth?.currentUser?.uid !== scope.authUid) return { valid: false, reason: 'AUTH_UID_CHANGED' };
  if (await appSessionService.readPendingEnd()) return { valid: false, reason: 'SESSION_END_PENDING' };
  const local = await appSessionService.readSession();
  if (!local || local.sessionId !== scope.sessionId || local.principalId !== scope.principalId
    || local.tourId !== scope.tourId) return { valid: false, reason: 'SESSION_CHANGED' };
  if (!await native.hasPermissions()) return { valid: false, reason: 'PERMISSION_REVOKED' };
  try {
    const connected = (await withTrackingTimeout(() => realtimeDb.ref('.info/connected').once('value'))).val();
    if (connected !== true) return { valid: false, reason: 'OFFLINE' };
    const result = await withTrackingTimeout(() => appSessionService.verifyCurrent({ authUid: scope.authUid, expectedSession: local }));
    return { ...result, expiresAtMs: result.session?.expiresAtMs };
  } catch { return { valid: false, reason: 'OFFLINE' }; }
};
export const driverTracking = createDriverTrackingController({ storage: AsyncStorage, native,
  verifyAuthority, writeFence: transport.writeFence, retireSession: transport.retireSession,
  publish: (intent, sample, isScopeCurrent) => transport.withPublicationGuard(intent, isScopeCurrent, () => publishDriverLocation({
    tourId: intent.scope.tourId, sessionScope: intent.scope, source: 'auto',
    sessionId: intent.liveSharingSessionId, dbInstance: transport.database,
    location: sample.coords, isScopeCurrent,
  })),
  withdraw: intent => withdrawLiveDriverLocation({ tourId: intent.scope.tourId,
    appSessionId: intent.scope.sessionId, expectedSessionId: intent.liveSharingSessionId,
    dbInstance: transport.database }),
});

export const registerDriverTrackingTask = () => {
  if (Platform.OS === 'web' || TaskManager.isTaskDefined(TRACKING_TASK_NAME)) return;
  TaskManager.defineTask(TRACKING_TASK_NAME, async ({ data, error }) => {
    try { await driverTracking.handleLocations({ locations: data?.locations, error }); }
    catch { await driverTracking.stop({ reason: 'task_error' }); }
  });
};
