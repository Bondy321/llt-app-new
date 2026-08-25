const {
  logger,
  parseTimestampMs,
  storage,
  SCHEMA_VERSION,
  RESPONSE,
  maskIdentifier,
  deriveActionScope,
  safeJsonParse,
  sanitizePhotoUploadPayload,
  resolveTourPackOwnerId,
  cacheKey,
  metaKey,
  withTourPackWriteLock,
} = require('./offlineSyncContext');

const saveTourPack = async (tourId, role, payload, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return RESPONSE.fail('tour pack payload must be an object');
    }
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    logger.info('OfflineSync', 'Tour pack save started', {
      tourId: maskIdentifier(tourId),
      role,
      payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
      hasFetchedAt: Boolean(payload?.fetchedAt),
    });
    const key = cacheKey(tourId, role, ownerId);
    const nextPayload = await withTourPackWriteLock(key, async () => {
      const rawExistingPack = await storage.getItemAsync(key);
      const existingPack = safeJsonParse(rawExistingPack, {});
      const fetchedAt = payload.fetchedAt || new Date().toISOString();
      const sourceVersion = payload.sourceVersion || SCHEMA_VERSION;
      const mergedPayload = {
        ...(!options.replaceExisting && existingPack && typeof existingPack === 'object' ? existingPack : {}),
        ...payload,
        fetchedAt,
        sourceVersion,
      };
      await storage.setItemAsync(key, JSON.stringify(mergedPayload));
      return mergedPayload;
    });
    logger.info('OfflineSync', 'Tour pack save completed', {
      tourId: maskIdentifier(tourId),
      role,
      fetchedAt: nextPayload.fetchedAt,
      sourceVersion: nextPayload.sourceVersion,
      mergedKeys: Object.keys(nextPayload).slice(0, 30),
    });
    return RESPONSE.ok(nextPayload);
  } catch (error) {
    logger.error('OfflineSync', 'Tour pack save failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};

const getTourPack = async (tourId, role, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    logger.debug('OfflineSync', 'Tour pack load started', {
      tourId: maskIdentifier(tourId),
      role,
    });
    const raw = await storage.getItemAsync(cacheKey(tourId, role, ownerId));
    const pack = safeJsonParse(raw, null);
    if (!pack) {
      logger.info('OfflineSync', 'Tour pack load missed cache', {
        tourId: maskIdentifier(tourId),
        role,
      });
      return RESPONSE.ok(null);
    }
    logger.info('OfflineSync', 'Tour pack load completed', {
      tourId: maskIdentifier(tourId),
      role,
      fetchedAt: pack.fetchedAt || null,
      sourceVersion: pack.sourceVersion || null,
      keys: Object.keys(pack).slice(0, 30),
    });
    return RESPONSE.ok(pack);
  } catch (error) {
    logger.error('OfflineSync', 'Tour pack load failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};

const setTourPackMeta = async (tourId, role, meta = {}, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    logger.debug('OfflineSync', 'Tour pack metadata save started', {
      tourId: maskIdentifier(tourId),
      role,
      metaKeys: meta && typeof meta === 'object' ? Object.keys(meta).slice(0, 20) : [],
    });
    const key = metaKey(tourId, role, ownerId);
    const payload = await withTourPackWriteLock(key, async () => {
      const rawExistingMeta = await storage.getItemAsync(key);
      const existingMeta = safeJsonParse(rawExistingMeta, {});
      const requestedLastSyncedAt = meta.lastSyncedAt || new Date().toISOString();
      const existingLastSyncedMs = parseTimestampMs(existingMeta?.lastSyncedAt);
      const requestedLastSyncedMs = parseTimestampMs(requestedLastSyncedAt);
      const lastSyncedAt = Number.isFinite(existingLastSyncedMs)
        && (!Number.isFinite(requestedLastSyncedMs) || existingLastSyncedMs > requestedLastSyncedMs)
        ? existingMeta.lastSyncedAt
        : requestedLastSyncedAt;
      const nextMeta = {
        ...(existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
          ? existingMeta
          : {}),
        ...meta,
        schemaVersion: SCHEMA_VERSION,
        lastSyncedAt,
      };
      await storage.setItemAsync(key, JSON.stringify(nextMeta));
      return nextMeta;
    });
    logger.info('OfflineSync', 'Tour pack metadata save completed', {
      tourId: maskIdentifier(tourId),
      role,
      lastSyncedAt: payload.lastSyncedAt,
      schemaVersion: payload.schemaVersion,
    });
    return RESPONSE.ok(payload);
  } catch (error) {
    logger.error('OfflineSync', 'Tour pack metadata save failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};

const getTourPackMeta = async (tourId, role, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    logger.debug('OfflineSync', 'Tour pack metadata load started', {
      tourId: maskIdentifier(tourId),
      role,
    });
    const raw = await storage.getItemAsync(metaKey(tourId, role, ownerId));
    const meta = safeJsonParse(raw, null);
    logger.info('OfflineSync', 'Tour pack metadata load completed', {
      tourId: maskIdentifier(tourId),
      role,
      found: Boolean(meta),
      lastSyncedAt: meta?.lastSyncedAt || null,
      schemaVersion: meta?.schemaVersion || null,
    });
    return RESPONSE.ok(meta);
  } catch (error) {
    logger.error('OfflineSync', 'Tour pack metadata load failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};

const buildAction = (action) => {
  const nowIso = new Date().toISOString();
  const payload = action.type === 'PHOTO_UPLOAD'
    ? sanitizePhotoUploadPayload(action.payload, action)
    : (action.payload || {});
  const scope = deriveActionScope({ ...action, payload });
  return {
    id: action.id || `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: action.type,
    tourId: action.tourId,
    createdAt: action.createdAt || nowIso,
    payload,
    attempts: Number.isFinite(action.attempts) ? action.attempts : 0,
    status: action.status || 'queued',
    lastError: action.lastError || null,
    nextAttemptAt: action.nextAttemptAt || null,
    lastUpdatedAt: nowIso,
    scope,
  };
};

const purgeTourPack = async (tourId, role, options = {}) => {
  try {
    if (!tourId || !role) return RESPONSE.fail('tourId and role are required');
    const ownerId = resolveTourPackOwnerId(tourId, role, options);
    if (!ownerId) return RESPONSE.fail('A tour-pack owner identity is required');
    const packStorageKey = cacheKey(tourId, role, ownerId);
    const metaStorageKey = metaKey(tourId, role, ownerId);

    await withTourPackWriteLock(packStorageKey, () => withTourPackWriteLock(metaStorageKey, async () => {
      await storage.deleteItemAsync(packStorageKey);
      await storage.deleteItemAsync(metaStorageKey);
    }));

    logger.info('OfflineSync', 'Purged one exact identity-scoped Tour Pack', {
      tourId: maskIdentifier(tourId),
      role,
    });
    return RESPONSE.ok({ purged: true });
  } catch (error) {
    logger.error('OfflineSync', 'Identity-scoped Tour Pack purge failed', {
      tourId: maskIdentifier(tourId),
      role,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
};
module.exports = {
  saveTourPack,
  getTourPack,
  setTourPackMeta,
  getTourPackMeta,
  buildAction,
  purgeTourPack,
};
