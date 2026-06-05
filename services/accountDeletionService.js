import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteUser } from 'firebase/auth';
import { auth, authHelpers, realtimeDb } from '../firebase';
import { createPersistenceProvider } from './persistenceProvider';
import loggerService, { maskIdentifier } from './loggerService';
import * as photoService from './photoService';

const { normalizeTourId } = require('./tourIdentityService');

export const PRIVACY_POLICY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim()
  || 'https://www.lochlomondtravel.com/images/pdfs/Loch_Lomond_Travel_Privacy_Policy.pdf';

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
  '@LLT:safetyOfflineQueue',
  '@LLT:trustedContacts',
];

const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;

const safeRealtimeKey = (value, fallback = 'anonymous') => {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const source = raw || fallback;
  return source.replace(
    REALTIME_KEY_INVALID_GLOBAL_PATTERN,
    (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`
  );
};

const toRealtimeKeySegment = (value) => safeRealtimeKey(value, '').replace(/^_+|_+$/g, '');

const addIdentity = (set, value) => {
  if (typeof value !== 'string') return;
  const normalized = value.trim();
  if (normalized) set.add(normalized);
};

const collectIdentityValues = ({ authUid, canonicalIdentity, bookingData, identityBinding }) => {
  const identities = new Set();
  addIdentity(identities, authUid);
  addIdentity(identities, canonicalIdentity?.principalId);
  addIdentity(identities, canonicalIdentity?.stablePassengerId);
  addIdentity(identities, canonicalIdentity?.authUid);
  addIdentity(identities, bookingData?.stablePassengerId);
  addIdentity(identities, bookingData?.privatePhotoOwnerId);
  addIdentity(identities, identityBinding?.stablePassengerId);
  addIdentity(identities, identityBinding?.authUid);

  const driverId = typeof bookingData?.id === 'string' && bookingData.id.trim().toUpperCase().startsWith('D-')
    ? bookingData.id.trim().toUpperCase()
    : null;
  if (driverId) {
    addIdentity(identities, driverId);
    addIdentity(identities, `driver:${driverId}`);
  }

  return [...identities];
};

const collectPrivatePhotoOwnerIds = ({ canonicalIdentity, bookingData, identityBinding }) => {
  const ownerIds = new Set();
  addIdentity(ownerIds, canonicalIdentity?.stablePassengerId);
  addIdentity(ownerIds, bookingData?.stablePassengerId);
  addIdentity(ownerIds, bookingData?.privatePhotoOwnerId);
  addIdentity(ownerIds, identityBinding?.stablePassengerId);
  return [...ownerIds];
};

const getDriverId = (bookingData) => {
  const value = typeof bookingData?.id === 'string' ? bookingData.id.trim().toUpperCase() : '';
  return value.startsWith('D-') ? value : null;
};

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

const buildAccountRecordUpdates = ({ authUid, identities, identityBinding, tourId, driverId, includeDriverLocation }) => {
  const updates = {};
  updates[`users/${authUid}`] = null;
  updates[`logs/${authUid}`] = null;
  if (tourId) updates[`tours/${tourId}/liveTracking/${authUid}`] = null;

  const stableKeys = new Set();
  addIdentity(stableKeys, identityBinding?.stablePassengerKey);
  addIdentity(stableKeys, identityBinding?.stablePassengerId);
  identities.forEach((identity) => {
    if (!identity.startsWith('driver:') && identity !== authUid) addIdentity(stableKeys, identity);
  });

  stableKeys.forEach((stableKey) => {
    const key = toRealtimeKeySegment(stableKey);
    if (key) updates[`identity_bindings/${key}/${authUid}`] = null;
  });

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
  summary,
}) => {
  const sessionKeyValues = sessionKeys ? Object.values(sessionKeys).filter(Boolean) : APP_SESSION_KEYS;

  const clearTasks = [
    sessionStorage?.multiRemove?.(sessionKeyValues),
    localStorage?.multiRemove?.([...APP_SESSION_KEYS, ...SAFETY_LOCAL_KEYS]),
  ].filter(Boolean);

  const authStorage = providerFactory({ namespace: 'LLT_AUTH' });
  const logStorage = providerFactory({ namespace: 'LLT_LOGS' });
  const offlineStorage = providerFactory({ namespace: 'LLT_OFFLINE' });

  clearTasks.push(authStorage.multiDeleteAsync(['LLT_authUser', 'LLT_authToken']));
  clearTasks.push(logStorage.multiDeleteAsync(['app_logs']));

  const offlineKeys = ['queue_v1', 'processed_action_ids_v1', 'last_success_at_v1'];
  if (tourId && role) {
    offlineKeys.push(`tour_pack_${role}_${tourId}`);
    offlineKeys.push(`tour_pack_meta_${role}_${tourId}`);
  }
  clearTasks.push(offlineStorage.multiDeleteAsync(offlineKeys));

  const results = await Promise.allSettled(clearTasks);
  summary.localStoresCleared = results.filter((result) => result.status === 'fulfilled').length;
  results
    .filter((result) => result.status === 'rejected')
    .forEach((result) => warn(summary, 'local_cleanup_failed', result.reason));
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
  const role = isDriverSession || driverId ? 'driver' : 'passenger';
  const identities = collectIdentityValues({ authUid, canonicalIdentity, bookingData, identityBinding });
  const privatePhotoOwnerIds = collectPrivatePhotoOwnerIds({ canonicalIdentity, bookingData, identityBinding });
  const identitySet = new Set(identities);
  const encodedIdentitySet = new Set(identities.map(toRealtimeKeySegment).filter(Boolean));

  try {
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
      error: error?.code === 'auth/requires-recent-login'
        ? 'Please restart the app and try Delete account again so we can refresh your secure session.'
        : (error?.message || 'Account deletion failed. Please try again.'),
    };
  }
};

export default {
  DATA_REQUEST_EMAIL,
  PRIVACY_POLICY_URL,
  deleteCurrentAccount,
};
