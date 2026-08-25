import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteUser } from 'firebase/auth';
import { auth, authHelpers, realtimeDb } from '../firebase';
import { createPersistenceProvider } from './persistenceProvider';
import loggerService, { maskIdentifier } from './loggerService';
import * as photoService from './photoService';
import appSessionService from './appSessionService';

const { normalizeTourId } = require('./tourIdentityService');
const {
  addIdentity,
  collectIdentityValues,
  collectPrivatePhotoOwnerIds,
  getDriverId,
  getPassengerBookingRef,
  safeRealtimeKey,
  toRealtimeKeySegment,
} = require('../src/features/account/domain/accountIdentityScope');

export const PRIVACY_POLICY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim()
  || 'https://lochlomondtravel.com/images/pdfs/Loch_Lomond_Travel_App_Privacy_Policy.pdf';

export const DATA_REQUEST_EMAIL =
  process.env.EXPO_PUBLIC_DATA_REQUEST_EMAIL?.trim()
  || 'support@lochlomondtravel.com';

const APP_SESSION_KEYS = [
  '@LLT:tourData',
  '@LLT:bookingData',
  '@LLT:lastScreen',
  '@LLT:notificationOnboarding',
  '@LLT:identityBinding',
];

const SAFETY_LOCAL_KEYS = [
  '@LLT:trustedContacts',
];
const SAFETY_QUEUE_KEY = '@LLT:safetyOfflineQueue';
const TRUSTED_CONTACTS_KEY_PREFIX = '@LLT:trustedContacts:v2:';

const getTourId = (tourData, bookingData) => normalizeTourId(
  tourData?.id,
  bookingData?.assignedTourId,
  tourData?.tourCode
);

const makeSummary = () => ({
  success: false,
  deletedAuthUid: null,
  replacementAuthUid: null,
  remoteRecordsCleared: 0,
  groupPhotosDeleted: 0,
  privatePhotosDeleted: 0,
  chatMessagesScrubbed: 0,
  reactionsRemoved: 0,
  localStoresCleared: 0,
  warnings: [],
});

const parseStoredArray = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const matchesDeletedIdentity = (value, identitySet) => (
  typeof value === 'string' && identitySet.has(value.trim())
);

const clearOwnedSafetyQueue = async (localStorage, identitySet) => {
  if (typeof localStorage?.getItem !== 'function') return;
  const raw = await localStorage.getItem(SAFETY_QUEUE_KEY);
  if (!raw) return;
  const queue = parseStoredArray(raw);
  const retained = queue.filter((event) => !(
    matchesDeletedIdentity(event?.sessionScope?.principalId, identitySet)
    || matchesDeletedIdentity(event?.principalId, identitySet)
    || matchesDeletedIdentity(event?.userId, identitySet)
  ));
  if (retained.length === 0) await localStorage.removeItem?.(SAFETY_QUEUE_KEY);
  else if (retained.length !== queue.length) await localStorage.setItem?.(SAFETY_QUEUE_KEY, JSON.stringify(retained));
};

const clearOwnedOfflineActions = async (offlineStorage, identitySet) => {
  if (typeof offlineStorage?.getItemAsync !== 'function') {
    // Compatibility fallback for injected/older providers that do not expose
    // reads. The production durable provider supports selective cleanup.
    const deleted = await offlineStorage?.multiDeleteAsync?.(['queue_v1']);
    if (deleted === false) {
      throw new Error('The offline action queue could not be cleared.');
    }
    return;
  }
  const raw = await offlineStorage.getItemAsync('queue_v1');
  if (!raw) return;
  const queue = parseStoredArray(raw);
  const retained = queue.filter((action) => !(
    matchesDeletedIdentity(action?.scope?.principalId, identitySet)
    || matchesDeletedIdentity(action?.payload?.principalId, identitySet)
    || matchesDeletedIdentity(action?.payload?.userId, identitySet)
    || matchesDeletedIdentity(action?.payload?.ownerId, identitySet)
  ));
  if (retained.length === queue.length) return;
  if (retained.length === 0 && typeof offlineStorage.deleteItemAsync === 'function') {
    await offlineStorage.deleteItemAsync('queue_v1');
  } else {
    await offlineStorage.setItemAsync('queue_v1', JSON.stringify(retained));
  }
};

const warn = (summary, label, error) => {
  summary.warnings.push({
    label,
    message: error?.message || String(error || 'Unknown error'),
  });
};

const snapshotChildren = (snapshot) => {
  const children = [];
  if (!snapshot?.exists?.()) return children;
  snapshot.forEach((child) => {
    children.push({ key: child.key, value: child.val() || {} });
  });
  return children;
};

const readChildren = async (db, path) => {
  const snapshot = await db.ref(path).once('value');
  return snapshotChildren(snapshot);
};

const matchesIdentity = (value, identitySet, encodedIdentitySet) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const normalized = value.trim();
  return identitySet.has(normalized) || encodedIdentitySet.has(normalized);
};

const deleteOwnedGroupPhotos = async ({ db, tourId, identitySet, encodedIdentitySet, photoApi, summary }) => {
  if (!tourId || !photoApi?.deleteGroupPhoto) return;

  const photos = await readChildren(db, `group_tour_photos/${tourId}`);
  for (const { key, value } of photos) {
    const ownerId = value?.userId || value?.ownerId || value?.privateOwnerId;
    if (!matchesIdentity(ownerId, identitySet, encodedIdentitySet)) continue;

    try {
      await photoApi.deleteGroupPhoto(tourId, key, ownerId);
      summary.groupPhotosDeleted += 1;
    } catch (error) {
      warn(summary, 'group_photo_delete_failed', error);
    }
  }
};

const deletePrivatePhotos = async ({ db, tourId, ownerIds, photoApi, summary }) => {
  if (!tourId || !photoApi?.deletePrivatePhoto) return;

  for (const ownerId of ownerIds) {
    const ownerKey = toRealtimeKeySegment(ownerId);
    if (!ownerKey) continue;

    let photos = [];
    try {
      photos = await readChildren(db, `private_tour_photos/${tourId}/${ownerKey}`);
    } catch (error) {
      warn(summary, 'private_photo_scan_failed', error);
      continue;
    }

    for (const { key } of photos) {
      try {
        await photoApi.deletePrivatePhoto(tourId, ownerId, key);
        summary.privatePhotosDeleted += 1;
      } catch (error) {
        warn(summary, 'private_photo_delete_failed', error);
      }
    }
  }
};

const buildChatScrubUpdates = ({
  rootPath,
  messages,
  identitySet,
  encodedIdentitySet,
  deletedBy,
  summary,
  messageCleanupMode = 'soft-delete',
}) => {
  const updates = {};
  const now = new Date().toISOString();

  for (const { key, value } of messages) {
    const messagePath = `${rootPath}/messages/${key}`;
    const senderMatches = matchesIdentity(value?.senderId, identitySet, encodedIdentitySet)
      || matchesIdentity(value?.senderStableId, identitySet, encodedIdentitySet);

    if (senderMatches && messageCleanupMode === 'remove') {
      updates[messagePath] = null;
      summary.chatMessagesScrubbed += 1;
      continue;
    }

    if (senderMatches && !value?.deleted) {
      updates[`${messagePath}/deleted`] = true;
      updates[`${messagePath}/text`] = '';
      updates[`${messagePath}/imageUrl`] = null;
      updates[`${messagePath}/thumbnailUrl`] = null;
      updates[`${messagePath}/deletedAt`] = now;
      updates[`${messagePath}/deletedBy`] = deletedBy;
      summary.chatMessagesScrubbed += 1;
    }

    const reactions = value?.reactions && typeof value.reactions === 'object' ? value.reactions : {};
    Object.entries(reactions).forEach(([emoji, userMap]) => {
      if (!userMap || typeof userMap !== 'object') return;
      Object.keys(userMap).forEach((actorKey) => {
        if (!matchesIdentity(actorKey, identitySet, encodedIdentitySet)) return;
        updates[`${messagePath}/reactions/${emoji}/${actorKey}`] = null;
        summary.reactionsRemoved += 1;
      });
    });
  }

  return updates;
};

const scrubChatContent = async ({ db, tourId, identitySet, encodedIdentitySet, deletedBy, includeInternal, summary }) => {
  if (!tourId) return {};

  const groupRoot = `chats/${tourId}`;
  const groupMessages = await readChildren(db, `${groupRoot}/messages`);
  const updates = buildChatScrubUpdates({
    rootPath: groupRoot,
    messages: groupMessages,
    identitySet,
    encodedIdentitySet,
    deletedBy,
    summary,
  });

  if (includeInternal) {
    const internalRoot = `internal_chats/${tourId}`;
    const internalMessages = await readChildren(db, `${internalRoot}/messages`);
    Object.assign(updates, buildChatScrubUpdates({
      rootPath: internalRoot,
      messages: internalMessages,
      identitySet,
      encodedIdentitySet,
      deletedBy,
      summary,
      messageCleanupMode: 'remove',
    }));
  }

  return updates;
};

const buildAccountRecordUpdates = ({
  authUid,
  identities,
  identityBinding,
  tourId,
  driverId,
  passengerBookingRef,
  includeDriverLocation,
}) => {
  const updates = {};
  updates[`users/${authUid}`] = null;
  updates[`logs/${authUid}`] = null;
  if (tourId) {
    updates[`tours/${tourId}/participants/${authUid}`] = null;
    updates[`tour_access_grants/${tourId}/${authUid}`] = null;
    updates[`tours/${tourId}/liveTracking/${authUid}`] = null;
    updates[`notification_read_state/${tourId}/${authUid}`] = null;
    updates[`notification_read_migration_requests/${tourId}/${authUid}`] = null;
  }

  const stableKeys = new Set();
  addIdentity(stableKeys, identityBinding?.stablePassengerKey);
  addIdentity(stableKeys, identityBinding?.stablePassengerId);
  identities.forEach((identity) => {
    if (!identity.startsWith('driver:') && identity !== authUid) addIdentity(stableKeys, identity);
    if (tourId) {
      const principalKey = toRealtimeKeySegment(identity);
      if (principalKey) updates[`notification_read_state/${tourId}/${principalKey}`] = null;
    }
  });

  if (!driverId) {
    stableKeys.forEach((stableKey) => {
      const key = toRealtimeKeySegment(stableKey);
      if (key) updates[`identity_bindings/${key}/${authUid}`] = null;
    });
  }

  if (passengerBookingRef) {
    updates[`booking_access_grants/${passengerBookingRef}/${authUid}`] = null;
    updates[`passenger_identity_security/${passengerBookingRef}/authorizedAuthUid`] = null;
  }

  if (driverId) {
    const driverKey = toRealtimeKeySegment(driverId);
    if (driverKey) updates[`drivers/${driverKey}/authUid`] = null;
  }

  if (includeDriverLocation && tourId) {
    updates[`tours/${tourId}/driverLocation`] = null;
  }

  return updates;
};

const clearLocalStores = async ({
  localStorage,
  sessionStorage,
  sessionKeys,
  providerFactory,
  tourId,
  role,
  packOwnerId,
  identities,
  summary,
}) => {
  const sessionKeyValues = sessionKeys ? Object.values(sessionKeys).filter(Boolean) : APP_SESSION_KEYS;

  const clearTasks = [
    sessionStorage?.multiRemove?.(sessionKeyValues),
    localStorage?.multiRemove?.([...APP_SESSION_KEYS, ...SAFETY_LOCAL_KEYS]),
  ].filter(Boolean);

  const authStorage = providerFactory({ namespace: 'LLT_AUTH' });
  const logStorage = providerFactory({
    namespace: 'LLT_LOGS',
    preferredStorage: 'async-storage',
    allowMemoryFallback: false,
    migrateFrom: ['secure-store'],
  });
  const offlineStorage = providerFactory({
    namespace: 'LLT_OFFLINE',
    preferredStorage: 'async-storage',
    allowMemoryFallback: false,
    migrateFrom: ['secure-store'],
  });
  const identitySet = new Set(identities || []);

  clearTasks.push(authStorage.multiDeleteAsync(['LLT_authUser', 'LLT_authToken']));
  clearTasks.push(logStorage.multiDeleteAsync(['app_logs']));

  const offlineKeys = [];
  if (tourId && role) {
    offlineKeys.push(`tour_pack_${role}_${tourId}`);
    offlineKeys.push(`tour_pack_meta_${role}_${tourId}`);
    const normalizedPackOwnerId = typeof packOwnerId === 'string'
      ? encodeURIComponent(packOwnerId.trim().toUpperCase())
      : null;
    if (normalizedPackOwnerId) {
      offlineKeys.push(`tour_pack_v2_${role}_${tourId}_${normalizedPackOwnerId}`);
      offlineKeys.push(`tour_pack_meta_v2_${role}_${tourId}_${normalizedPackOwnerId}`);
    }
  }
  if (offlineKeys.length > 0) clearTasks.push(offlineStorage.multiDeleteAsync(offlineKeys));
  clearTasks.push(clearOwnedOfflineActions(offlineStorage, identitySet));
  clearTasks.push(clearOwnedSafetyQueue(localStorage, identitySet));
  if (typeof localStorage?.multiRemove === 'function') {
    clearTasks.push(localStorage.multiRemove((identities || []).map(
      (identity) => `${TRUSTED_CONTACTS_KEY_PREFIX}${encodeURIComponent(identity)}`,
    )));
  }

  const results = await Promise.allSettled(clearTasks);
  summary.localStoresCleared = results.filter(
    (result) => result.status === 'fulfilled' && result.value !== false,
  ).length;
  results.forEach((result) => {
    if (result.status === 'rejected') {
      warn(summary, 'local_cleanup_failed', result.reason);
    } else if (result.value === false) {
      warn(summary, 'local_cleanup_failed', new Error('A local storage provider could not clear its records.'));
    }
  });
};

const getAccountDeletionErrorMessage = (error) => {
  if (error?.code === 'auth/requires-recent-login') {
    return 'Please restart the app and try Delete account again so we can refresh your secure session.';
  }
  if (/network|offline|timeout|timed out/i.test(`${error?.code || ''} ${error?.message || ''}`)) {
    return 'Account deletion could not reach app services. Check your connection and try again.';
  }
  if (/permission|unauthori[sz]ed/i.test(`${error?.code || ''} ${error?.message || ''}`)) {
    return 'Account deletion could not verify all required permissions. Sign in again and retry.';
  }
  return 'Account deletion could not be completed safely. Please try again.';
};

export const deleteCurrentAccount = async ({
  tourData = null,
  bookingData = null,
  canonicalIdentity = null,
  identityBinding = null,
  isDriverSession = false,
  sessionStorage = null,
  sessionKeys = null,
  db = realtimeDb,
  currentUser = auth?.currentUser || null,
  deleteUserFn = deleteUser,
  authHelpersOverride = authHelpers,
  localStorage = AsyncStorage,
  providerFactory = createPersistenceProvider,
  photoApi = photoService,
  appSessionApi = appSessionService,
  logger = loggerService,
} = {}) => {
  const summary = makeSummary();
  const authUid = currentUser?.uid || null;

  if (!authUid) {
    return {
      ...summary,
      error: 'No signed-in app account is available to delete.',
    };
  }

  if (!db?.ref) {
    return {
      ...summary,
      error: 'Account deletion requires an internet connection to reach app services.',
    };
  }

  const tourId = getTourId(tourData, bookingData);
  const driverId = getDriverId(bookingData);
  const passengerBookingRef = getPassengerBookingRef(bookingData);
  const role = isDriverSession || driverId ? 'driver' : 'passenger';
  const identities = collectIdentityValues({ authUid, canonicalIdentity, bookingData, identityBinding });
  const privatePhotoOwnerIds = collectPrivatePhotoOwnerIds({ canonicalIdentity, bookingData, identityBinding });
  const identitySet = new Set(identities);
  const encodedIdentitySet = new Set(identities.map(toRealtimeKeySegment).filter(Boolean));

  try {
    const activeAppSession = await appSessionApi.readSession();
    if (!activeAppSession) {
      throw new Error('A current secure app session is required for account deletion.');
    }
    logger.info('AccountDeletion', 'Account deletion started', {
      authUid: maskIdentifier(authUid),
      tourId,
      role,
      identityCount: identities.length,
    });

    await deleteOwnedGroupPhotos({
      db,
      tourId,
      identitySet,
      encodedIdentitySet,
      photoApi,
      summary,
    });

    await deletePrivatePhotos({
      db,
      tourId,
      ownerIds: privatePhotoOwnerIds,
      photoApi,
      summary,
    });

    const recordUpdates = buildAccountRecordUpdates({
      authUid,
      identities,
      identityBinding,
      tourId,
      driverId,
      passengerBookingRef,
      includeDriverLocation: role === 'driver',
    });

    let chatUpdates = {};
    try {
      chatUpdates = await scrubChatContent({
        db,
        tourId,
        identitySet,
        encodedIdentitySet,
        deletedBy: authUid,
        includeInternal: role === 'driver',
        summary,
      });
    } catch (error) {
      warn(summary, 'chat_scrub_failed', error);
    }

    const updates = { ...recordUpdates, ...chatUpdates };
    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
      summary.remoteRecordsCleared = Object.keys(updates).length;
    }

    const sessionEnd = await appSessionApi.endSession({ authUid, session: activeAppSession });
    if (!sessionEnd?.success) {
      throw new Error('Account deletion could not revoke the active app session.');
    }
    await appSessionApi.completeEnd();

    if (typeof authHelpersOverride?.clearAuthData === 'function') {
      await authHelpersOverride.clearAuthData();
    }

    await deleteUserFn(currentUser);
    summary.deletedAuthUid = authUid;

    await clearLocalStores({
      localStorage,
      sessionStorage,
      sessionKeys,
      providerFactory,
      tourId,
      role,
      packOwnerId: bookingData?.id || null,
      identities,
      summary,
    });

    if (typeof authHelpersOverride?.ensureAuthenticated === 'function') {
      try {
        const replacementUser = await authHelpersOverride.ensureAuthenticated();
        summary.replacementAuthUid = replacementUser?.uid || null;
      } catch (error) {
        warn(summary, 'replacement_auth_failed', error);
      }
    }

    summary.success = true;
    logger.info('AccountDeletion', 'Account deletion completed', {
      authUid: maskIdentifier(authUid),
      replacementAuthUid: maskIdentifier(summary.replacementAuthUid),
      warningCount: summary.warnings.length,
      remoteRecordsCleared: summary.remoteRecordsCleared,
    });
    return summary;
  } catch (error) {
    logger.error('AccountDeletion', 'Account deletion failed', {
      authUid: maskIdentifier(authUid),
      error: error?.message || String(error),
      code: error?.code || null,
    });
    return {
      ...summary,
      error: getAccountDeletionErrorMessage(error),
    };
  }
};

export const __accountDeletionTestables = {
  clearOwnedOfflineActions,
  clearOwnedSafetyQueue,
  getAccountDeletionErrorMessage,
};

export default {
  DATA_REQUEST_EMAIL,
  PRIVACY_POLICY_URL,
  deleteCurrentAccount,
};
