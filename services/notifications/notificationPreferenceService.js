import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import appMetadataModule from '../appMetadata';
import {
  TOUR_NOTIFICATION_CATEGORY_KEYS,
  hasMarketingPreferenceInput,
} from '../../utils/notificationCategories';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  extractPreferenceSource,
  hasOwn,
  logger,
  maskIdentifier,
  permissionStateDescriptions,
  realtimeDb,
  resolveNotificationUserId,
  validatePreferences,
  withTimeout,
} from './notificationContext';
import {
  buildUnavailableTokenPatch,
  normalizeNotificationPreferences,
  primeNotificationPermissions,
  registerForPushNotificationsAsync,
} from './notificationRegistrationService';
import { updateNotificationPreferences } from './notificationDeviceApiService';

const { resolveAppVersionMetadata } = appMetadataModule;

export const saveUserPreferences = async (userId, preferences, options = {}) => {
  try {
    // Validate inputs
    const validatedUserId = resolveNotificationUserId(userId);
    const validatedPreferences = validatePreferences(preferences);
    logger.info('NotificationService', 'Preference save started', {
      userId: maskIdentifier(validatedUserId),
      hasOps: Boolean(extractPreferenceSource(validatedPreferences)?.ops),
      hasMarketing: Boolean(extractPreferenceSource(validatedPreferences)?.marketing),
    });

    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const userRef = realtimeDb.ref(`users/${validatedUserId}`);

    // Verify the remote destination before triggering an OS permission prompt.
    // Permission decisions can take human time, so keep a bounded one-minute gate.
    const preferenceSourceRef = options?.marketingOnly
      ? realtimeDb.ref(`notification_devices/${validatedUserId}`)
      : userRef;
    const userSnapshot = await withTimeout(
      preferenceSourceRef.once('value'),
      'Existing preferences fetch timeout',
    );
    const suppliedPermissionState = options?.permissionState;
    const permissionProbe = suppliedPermissionState?.state
      ? { success: true, data: suppliedPermissionState }
      : await withTimeout(primeNotificationPermissions({
        userId: validatedUserId,
        requestIfNeeded: options?.requestIfNeeded === true,
        persistState: false,
      }), 'Permission check timeout', 60_000);

    const rawExistingData = userSnapshot.val() || {};
    const existingUserData = options?.marketingOnly
      ? { preferences: { marketing: rawExistingData.marketingPreferences || {} } }
      : rawExistingData;
    logger.debug('NotificationService', 'Existing notification preference record loaded', {
      userId: maskIdentifier(validatedUserId),
      hasExistingPreferences: Boolean(existingUserData.preferences),
      pushTokenStatus: existingUserData.pushTokenStatus || null,
      permissionState: existingUserData.pushPermissionState || null,
    });
    const existingRemotePreferences = normalizeNotificationPreferences(existingUserData.preferences);
    const incomingPreferences = normalizeNotificationPreferences(validatedPreferences);
    const incomingSource = extractPreferenceSource(validatedPreferences);

    const mergedOps = {
      ...DEFAULT_NOTIFICATION_PREFERENCES.ops,
      ...(existingRemotePreferences.ops || {}),
    };

    if (incomingSource?.ops && typeof incomingSource.ops === 'object') {
      Object.keys(DEFAULT_NOTIFICATION_PREFERENCES.ops).forEach((key) => {
        if (hasOwn(incomingSource.ops, key)) {
          mergedOps[key] = incomingPreferences.ops[key];
        }
      });
    }

    const mergedMarketing = {
      ...DEFAULT_NOTIFICATION_PREFERENCES.marketing,
      ...(existingRemotePreferences.marketing || {}),
    };

    if (incomingSource?.marketing && typeof incomingSource.marketing === 'object') {
      TOUR_NOTIFICATION_CATEGORY_KEYS.forEach((key) => {
        if (hasMarketingPreferenceInput(incomingSource.marketing, key)) {
          mergedMarketing[key] = incomingPreferences.marketing[key];
        }
      });
    }

    const mergedPreferences = {
      ops: mergedOps,
      marketing: mergedMarketing,
    };

    const permissionState = permissionProbe?.success
      ? permissionProbe.data
      : {
        state: 'unavailable',
        granted: false,
        canAskAgain: false,
        status: 'unavailable',
        description: permissionProbe?.error || permissionStateDescriptions.unavailable,
      };

    const nowIso = new Date().toISOString();
    const updateServerProjection = (pushToken = null) => updateNotificationPreferences({
      pushToken,
      permissionState: permissionState.state,
      permissionCanAskAgain: permissionState.canAskAgain === true,
      marketingPreferences: mergedPreferences.marketing,
      appVersion: Constants.expoConfig?.version || null,
      appBuild: Constants.expoConfig?.ios?.buildNumber || Constants.expoConfig?.android?.versionCode?.toString() || null,
      platform: Platform.OS,
    });

    if (!permissionState.granted) {
      if (!options?.marketingOnly) {
        await withTimeout(
          userRef.update(buildUnavailableTokenPatch({
            nowIso,
            existingUserData,
            permissionState,
            mergedPreferences,
          })),
          'Preferences save timeout'
        );
      }
      await withTimeout(updateServerProjection(), 'Notification consent save timeout');

      logger.info('NotificationService', 'Preferences saved without active push token', {
        userId: maskIdentifier(validatedUserId),
        permissionState: permissionState.state,
        reason: 'permission_not_granted',
      });
      return {
        success: true,
        warning: 'Preferences saved, but notifications are disabled (no permission or not on physical device)',
        permissionState,
      };
    }

    // 2. Get the token (permission already granted above)
    const token = await registerForPushNotificationsAsync(3, { permissionGranted: true });

    if (!token) {
      if (!options?.marketingOnly) {
        await withTimeout(
          userRef.update(buildUnavailableTokenPatch({
            nowIso,
            existingUserData,
            permissionState,
            mergedPreferences,
          })),
          'Preferences save timeout'
        );
      }
      await withTimeout(updateServerProjection(), 'Notification consent save timeout');

      logger.warn('NotificationService', 'Preferences saved but push token unavailable', {
        userId: maskIdentifier(validatedUserId),
        permissionState: permissionState.state,
      });
      return {
        success: true,
        warning: 'Preferences saved, but notifications are disabled (no permission or not on physical device)',
        permissionState,
      };
    }

    // 3. Save token and preferences
    const appVersionMetadata = resolveAppVersionMetadata({
      constants: Constants,
      platform: Platform,
    });

    const updateData = {
      pushToken: token,
      pushTokenStatus: 'ACTIVE',
      pushTokenUpdatedAt: nowIso,
      pushTokenProvider: 'expo',
      pushTokenInvalidReason: null,
      pushPermissionState: permissionState.state,
      pushPermissionCanAskAgain: permissionState.canAskAgain,
      pushPermissionUpdatedAt: nowIso,
      preferences: mergedPreferences,
      lastUpdated: nowIso,
      deviceOS: Platform.OS,
      deviceModel: Device.modelName || 'Unknown',
      appVersion: appVersionMetadata.appVersion,
      appBuild: appVersionMetadata.appBuild,
      osVersion: appVersionMetadata.osVersion,
    };

    if (!options?.marketingOnly) await withTimeout(userRef.update(updateData), 'Preferences save timeout');
    await withTimeout(updateServerProjection(token), 'Notification consent save timeout');

    logger.info('NotificationService', 'Preferences saved with active push token', {
      userId: maskIdentifier(validatedUserId),
      permissionState: permissionState.state,
      deviceOS: Platform.OS,
      appVersion: appVersionMetadata.appVersion,
      appBuild: appVersionMetadata.appBuild,
    });
    return { success: true, permissionState };
  } catch (error) {
    logger.error('NotificationService', 'Preference save failed', {
      userId: maskIdentifier(userId),
      error: error?.message || String(error),
    });
    return { success: false, error: error.message };
  }
};

/**
 * Removes this authenticated device from push delivery when its in-app session
 * ends. Firebase Auth intentionally remains anonymous and signed in, so logout
 * must explicitly deactivate the token stored under that auth uid.
 */
export const deactivatePushToken = async (userId) => {
  try {
    const validatedUserId = resolveNotificationUserId(userId);
    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const nowIso = new Date().toISOString();
    await withTimeout(
      realtimeDb.ref(`users/${validatedUserId}`).update({
        pushToken: null,
        pushTokenStatus: 'UNAVAILABLE',
        pushTokenInvalidReason: 'SIGNED_OUT',
        pushTokenUpdatedAt: nowIso,
        lastUpdated: nowIso,
      }),
      'Push token deactivation timeout'
    );

    logger.info('NotificationService', 'Push token deactivated for signed-out session', {
      userId: maskIdentifier(validatedUserId),
    });
    return { success: true };
  } catch (error) {
    logger.warn('NotificationService', 'Push token deactivation failed', {
      userId: maskIdentifier(userId),
      error: error?.message || String(error),
    });
    return { success: false, error: error?.message || String(error) };
  }
};

/**
 * Restores push delivery after a successful app login without prompting for
 * permission or changing the traveller's saved preferences.
 */
export const restorePushTokenForSession = async (userId) => {
  try {
    const validatedUserId = resolveNotificationUserId(userId);
    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const userRef = realtimeDb.ref(`users/${validatedUserId}`);
    const snapshot = await withTimeout(
      userRef.once('value'),
      'Push token restore fetch timeout'
    );
    const userData = snapshot.val() || {};
    if (userData.pushTokenStatus === 'ACTIVE' && userData.pushToken) {
      return { success: true, restored: false, reason: 'already_active' };
    }
    if (userData.pushTokenInvalidReason !== 'SIGNED_OUT' || !userData.preferences) {
      return { success: true, restored: false, reason: 'not_signed_out' };
    }

    const permissionProbe = await primeNotificationPermissions({
      userId: validatedUserId,
      requestIfNeeded: false,
      persistState: false,
    });
    if (!permissionProbe?.success || !permissionProbe.data?.granted) {
      return { success: true, restored: false, reason: 'permission_not_granted' };
    }

    const token = await registerForPushNotificationsAsync(3, { permissionGranted: true });
    if (!token) {
      return { success: false, restored: false, error: 'Push token is unavailable' };
    }

    const nowIso = new Date().toISOString();
    await withTimeout(
      userRef.update({
        pushToken: token,
        pushTokenStatus: 'ACTIVE',
        pushTokenProvider: 'expo',
        pushTokenInvalidReason: null,
        pushTokenUpdatedAt: nowIso,
        pushPermissionState: permissionProbe.data.state,
        pushPermissionCanAskAgain: permissionProbe.data.canAskAgain,
        pushPermissionUpdatedAt: nowIso,
        lastUpdated: nowIso,
      }),
      'Push token restore timeout'
    );
    logger.info('NotificationService', 'Push token restored for signed-in session', {
      userId: maskIdentifier(validatedUserId),
    });
    return { success: true, restored: true };
  } catch (error) {
    logger.warn('NotificationService', 'Push token restore failed', {
      userId: maskIdentifier(userId),
      error: error?.message || String(error),
    });
    return { success: false, restored: false, error: error?.message || String(error) };
  }
};

/**
 * Loads existing preferences from Firebase
 * Enhanced with validation and timeout protection
 */
export const getUserPreferences = async (userId, options = {}) => {
  const { throwOnError = false } = options || {};

  try {
    // Validate input
    const validatedUserId = resolveNotificationUserId(userId);
    logger.info('NotificationService', 'Preference fetch started', {
      userId: maskIdentifier(validatedUserId),
      throwOnError,
    });

    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const prefsRef = options?.preferDevice
      ? realtimeDb.ref(`notification_devices/${validatedUserId}`)
      : realtimeDb.ref(`users/${validatedUserId}/preferences`);

    const snapshot = await withTimeout(
      prefsRef.once('value'),
      'Preferences fetch timeout'
    );

    const sourceValue = snapshot.val() || null;
    const preferences = options?.preferDevice && sourceValue
      ? { marketing: sourceValue.marketingPreferences || {} }
      : sourceValue;
    const normalizedPreferences = preferences ? normalizeNotificationPreferences(preferences) : null;
    logger.info('NotificationService', 'Preference fetch completed', {
      userId: maskIdentifier(validatedUserId),
      hasPreferences: Boolean(preferences),
    });
    return normalizedPreferences;
  } catch (error) {
    logger.error('NotificationService', 'Preference fetch failed', {
      userId: maskIdentifier(userId),
      throwOnError,
      error: error?.message || String(error),
    });

    if (throwOnError) {
      throw error;
    }

    return null;
  }
};

export const getNotificationDeviceReadiness = async (userId) => {
  const validatedUserId = resolveNotificationUserId(userId);
  if (!realtimeDb) throw new Error('Database not initialized');
  const snapshot = await withTimeout(
    realtimeDb.ref(`notification_devices/${validatedUserId}`).once('value'),
    'Notification readiness fetch timeout',
  );
  const device = snapshot.val() || {};
  return {
    status: typeof device.status === 'string' ? device.status : 'unregistered',
    permissionState: typeof device.permissionState === 'string' ? device.permissionState : 'unavailable',
    tokenHealthy: device.status === 'active' && typeof device.tokenHash === 'string' && device.tokenHash.length === 64,
    operationalEligible: device.operationalEligible === true,
    marketingEligible: device.marketingEligible === true,
    updatedAtMs: Number(device.updatedAtMs || 0),
  };
};
