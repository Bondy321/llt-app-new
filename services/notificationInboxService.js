const { parseTimestampMs } = require('./timeUtils');
const { normalizeTourId } = require('./tourIdentityService');
const { createPersistenceProvider } = require('./persistenceProvider');

const MAX_VISIBLE_NOTICES = 50;
const MAX_READ_STATE_RECORDS = 100;
const NOTIFICATION_CACHE_VERSION = 1;
const NOTIFICATION_CACHE_MAX_TOURS_PER_USER = 25;
const NOTIFICATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_TYPES = new Set(['announcement', 'itinerary', 'driver_tour_pack']);
const ALLOWED_SCREENS = new Set(['Chat', 'Itinerary', 'DriverTourPack']);
const DRIVER_SECTIONS = new Set(['status', 'tour', 'pickups', 'passengers', 'seats', 'timeline', 'hotels', 'services', 'coach', 'contacts', 'itineraries', 'coverage', 'quality']);
const PII = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\+?\d[\d\s().-]{7,}\d)/i;
const notificationCacheStorage = createPersistenceProvider({
  namespace: 'LLT_NOTIFICATION_INBOX',
  preferredStorage: 'async-storage',
  allowMemoryFallback: true,
});
const notificationCacheGenerations = new Map();
const notificationCacheWriteChains = new Map();
const notificationFeedSubscriptions = new Map();

const requireSafeKey = (value, label) => {
  const normalized = String(value || '').trim();
  if (!normalized || /[.#$/\[\]]/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
};

const getFirebaseServices = () => require('../firebase');

const encodeCachePart = (value) => encodeURIComponent(String(value));
const requireCacheScope = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 240) throw new Error('Invalid notification cache scope');
  return normalized;
};
const feedCacheKey = (tourId, userId, cacheOwnerId = userId) => `feed_v${NOTIFICATION_CACHE_VERSION}_${encodeCachePart(userId)}_${encodeCachePart(cacheOwnerId)}_${encodeCachePart(tourId)}`;
const feedCacheIndexKey = (userId) => `index_v${NOTIFICATION_CACHE_VERSION}_${encodeCachePart(userId)}`;
const feedCacheGenerationKey = (userId) => `generation_v${NOTIFICATION_CACHE_VERSION}_${encodeCachePart(userId)}`;

const runSerializedCacheOperation = (userId, operation) => {
  const previous = notificationCacheWriteChains.get(userId) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  notificationCacheWriteChains.set(userId, next);
  return next.finally(() => {
    if (notificationCacheWriteChains.get(userId) === next) notificationCacheWriteChains.delete(userId);
  });
};

const retryCachePrivacyOperation = async (operation, maxAttempts = 3) => {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Notification cache privacy operation failed');
};

const revokeNotificationFeedSubscriptions = (userId) => {
  const subscriptions = notificationFeedSubscriptions.get(userId);
  if (!subscriptions) return 0;
  const activeSubscriptions = [...subscriptions];
  activeSubscriptions.forEach((unsubscribe) => unsubscribe());
  return activeSubscriptions.length;
};

const readNotificationCacheGeneration = async ({ userId, storage = notificationCacheStorage }) => {
  const inMemory = notificationCacheGenerations.get(userId);
  if (Number.isSafeInteger(inMemory) && inMemory >= 0) return inMemory;
  let generation = 0;
  try {
    const raw = await storage.getItemAsync(feedCacheGenerationKey(userId));
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) generation = parsed;
  } catch (_error) {
    generation = 0;
  }
  notificationCacheGenerations.set(userId, generation);
  return generation;
};

const parseCachedFeed = (raw, {
  tourId,
  userId,
  cacheOwnerId = userId,
  generation = 0,
  now = Date.now(),
}) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== NOTIFICATION_CACHE_VERSION
      || parsed?.tourId !== tourId
      || parsed?.userId !== userId
      || parsed?.cacheOwnerId !== cacheOwnerId
      || parsed?.generation !== generation
      || !Number.isFinite(parsed?.cachedAtMs)
      || parsed.cachedAtMs > now + 60_000
      || now - parsed.cachedAtMs > NOTIFICATION_CACHE_TTL_MS
      || !Array.isArray(parsed?.items)) {
      return null;
    }

    const noticeMap = {};
    const readState = {};
    parsed.items.slice(0, MAX_VISIBLE_NOTICES).forEach((item) => {
      const noticeId = typeof item?.noticeId === 'string' ? item.noticeId : item?.id;
      if (!noticeId) return;
      noticeMap[noticeId] = item;
      if (Number.isFinite(parseTimestampMs(item?.readAtMs))) {
        readState[noticeId] = item.readAtMs;
      }
    });
    return {
      items: buildNotificationFeed(noticeMap, readState),
      cachedAtMs: parsed.cachedAtMs,
    };
  } catch (_error) {
    return null;
  }
};

const loadNotificationFeedCache = async ({
  tourId,
  userId,
  cacheOwnerId = userId,
  generation,
  storage = notificationCacheStorage,
  now = Date.now(),
}) => {
  const resolvedGeneration = Number.isSafeInteger(generation)
    ? generation
    : await readNotificationCacheGeneration({ userId, storage });
  const raw = await storage.getItemAsync(feedCacheKey(tourId, userId, cacheOwnerId));
  return parseCachedFeed(raw, {
    tourId,
    userId,
    cacheOwnerId,
    generation: resolvedGeneration,
    now,
  });
};

const persistNotificationFeedCache = async ({
  tourId,
  userId,
  cacheOwnerId = userId,
  items,
  storage = notificationCacheStorage,
  now = Date.now(),
  expectedGeneration,
}) => {
  const safeCacheOwnerId = requireCacheScope(cacheOwnerId);
  const generation = Number.isSafeInteger(expectedGeneration)
    ? expectedGeneration
    : await readNotificationCacheGeneration({ userId, storage });

  return runSerializedCacheOperation(userId, async () => {
    const currentGeneration = await readNotificationCacheGeneration({ userId, storage });
    if (generation !== currentGeneration) return false;

    const key = feedCacheKey(tourId, userId, safeCacheOwnerId);
    const indexKey = feedCacheIndexKey(userId);
    let indexedScopes = [];
    try {
      const rawIndex = await storage.getItemAsync(indexKey);
      const parsedIndex = rawIndex ? JSON.parse(rawIndex) : [];
      if (Array.isArray(parsedIndex)) {
        indexedScopes = parsedIndex.filter((value) => (
          value && typeof value.cacheOwnerId === 'string' && typeof value.tourId === 'string'
        ));
      }
    } catch (_error) {
      indexedScopes = [];
    }
    const nextEntry = { cacheOwnerId: safeCacheOwnerId, tourId };
    const previousScopes = indexedScopes;
    indexedScopes = [nextEntry, ...previousScopes.filter((value) => (
      value.cacheOwnerId !== safeCacheOwnerId || value.tourId !== tourId
    ))].slice(0, NOTIFICATION_CACHE_MAX_TOURS_PER_USER);
    const evictedScopes = previousScopes.filter((value) => !indexedScopes.some((candidate) => (
      candidate.cacheOwnerId === value.cacheOwnerId && candidate.tourId === value.tourId
    )));
    if (evictedScopes.length > 0) {
      await storage.multiDeleteAsync(evictedScopes.map((scope) => (
        feedCacheKey(scope.tourId, userId, scope.cacheOwnerId)
      )));
    }
    const saved = await storage.multiSetAsync([
      [key, JSON.stringify({
        version: NOTIFICATION_CACHE_VERSION,
        tourId,
        userId,
        cacheOwnerId: safeCacheOwnerId,
        generation,
        cachedAtMs: now,
        items: items.slice(0, MAX_VISIBLE_NOTICES),
      })],
      [indexKey, JSON.stringify(indexedScopes)],
    ]);
    return saved !== false;
  });
};

const clearNotificationFeedCache = async ({
  userId,
  storage = notificationCacheStorage,
}) => {
  const safeUserId = requireSafeKey(userId, 'notification cache user id');
  revokeNotificationFeedSubscriptions(safeUserId);
  const revokedGeneration = (notificationCacheGenerations.get(safeUserId) || 0) + 1;
  notificationCacheGenerations.set(safeUserId, revokedGeneration);

  return runSerializedCacheOperation(safeUserId, async () => {
    const indexKey = feedCacheIndexKey(safeUserId);
    const generationKey = feedCacheGenerationKey(safeUserId);
    let persistedGeneration = 0;
    let indexedScopes = [];
    try {
      const [rawGeneration, rawIndex] = await Promise.all([
        storage.getItemAsync(generationKey),
        storage.getItemAsync(indexKey),
      ]);
      const parsedGeneration = Number(rawGeneration);
      if (Number.isSafeInteger(parsedGeneration) && parsedGeneration >= 0) persistedGeneration = parsedGeneration;
      const parsedIndex = rawIndex ? JSON.parse(rawIndex) : [];
      if (Array.isArray(parsedIndex)) {
        indexedScopes = parsedIndex.filter((value) => (
          value && typeof value.cacheOwnerId === 'string' && typeof value.tourId === 'string'
        ));
      }
    } catch (_error) {
      indexedScopes = [];
    }

    const nextGeneration = Math.max(revokedGeneration, persistedGeneration + 1);
    notificationCacheGenerations.set(safeUserId, nextGeneration);
    const cacheKeys = [
      ...indexedScopes.map((scope) => feedCacheKey(scope.tourId, safeUserId, scope.cacheOwnerId)),
      indexKey,
    ];
    const [generationResult, deletionResult] = await Promise.allSettled([
      retryCachePrivacyOperation(() => storage.setItemAsync(generationKey, String(nextGeneration))),
      retryCachePrivacyOperation(() => storage.multiDeleteAsync(cacheKeys)),
    ]);
    if (generationResult.status === 'rejected') {
      throw generationResult.reason;
    }
    if (deletionResult.status === 'rejected') {
      throw deletionResult.reason;
    }
    return indexedScopes.length;
  });
};

const resolveInboxUserId = (candidate, authOverride) => {
  const auth = authOverride === undefined ? getFirebaseServices().auth : authOverride;
  const authUid = auth?.currentUser?.uid;
  return requireSafeKey(authUid || candidate, 'notification user id');
};

const requestNotificationReadStateMigration = async ({
  tourId,
  userId,
  readStateOwnerId,
  db: dbOverride,
  auth: authOverride,
  now = Date.now(),
}) => {
  const db = dbOverride || getFirebaseServices().realtimeDb;
  const safeTourId = requireSafeKey(normalizeTourId(tourId), 'tour id');
  const safeUserId = resolveInboxUserId(userId, authOverride);
  const safeReadStateOwnerId = requireSafeKey(readStateOwnerId || safeUserId, 'notification read-state owner id');
  if (safeReadStateOwnerId === safeUserId) return false;
  await db.ref(`notification_read_migration_requests/${safeTourId}/${safeUserId}`).set({
    version: 1,
    principalId: safeReadStateOwnerId,
    requestedAtMs: now,
  });
  return true;
};

const normalizeTourNotice = (noticeId, raw = {}) => {
  const createdAtMs = parseTimestampMs(raw.createdAtMs ?? raw.createdAt);
  const type = ALLOWED_TYPES.has(raw.type) ? raw.type : null;
  const screen = ALLOWED_SCREENS.has(raw.screen) ? raw.screen : null;
  const tourId = normalizeTourId(raw.tourId);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';

  const isDriverPack = type === 'driver_tour_pack' || screen === 'DriverTourPack';
  const departureKey = typeof raw.departureKey === 'string' && /^\d{4}-\d{2}-\d{2}::[A-Z0-9_-]{1,120}$/i.test(raw.departureKey) ? raw.departureKey : null;
  const revision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : null;
  const changedSectionSource = Array.isArray(raw.changedSections)
    ? raw.changedSections
    : typeof raw.changedSections === 'string' ? raw.changedSections.split(',') : [];
  const changedSections = [...new Set(changedSectionSource.map((item) => String(item).trim()).filter((item) => DRIVER_SECTIONS.has(item)))].slice(0, 13);
  if (!noticeId || !type || !screen || !tourId || !title || !body || !Number.isFinite(createdAtMs) || (isDriverPack && (!departureKey || !revision || PII.test(title) || PII.test(body)))) {
    return null;
  }

  return {
    id: noticeId,
    noticeId,
    version: raw.version === 1 ? 1 : 0,
    type,
    title,
    body,
    tourId,
    screen,
    sourceId: typeof raw.sourceId === 'string' ? raw.sourceId : null,
    messageId: typeof raw.messageId === 'string'
      ? raw.messageId
      : type === 'announcement' && typeof raw.sourceId === 'string'
        ? raw.sourceId
        : null,
    priority: raw.priority === 'high' ? 'high' : 'normal',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(createdAtMs).toISOString(),
    createdAtMs,
    ...(isDriverPack ? { departureKey, revision, changedSections, critical: raw.critical === true, requiresAcknowledgement: raw.requiresAcknowledgement === true } : {}),
  };
};

const buildNotificationFeed = (noticeMap = {}, readState = {}) => Object.entries(noticeMap || {})
  .map(([noticeId, raw]) => normalizeTourNotice(noticeId, raw))
  .filter(Boolean)
  .map((notice) => ({
    ...notice,
    readAtMs: Number.isFinite(parseTimestampMs(readState?.[notice.id]))
      ? parseTimestampMs(readState[notice.id])
      : null,
    isRead: Number.isFinite(parseTimestampMs(readState?.[notice.id])),
  }))
  .sort((left, right) => right.createdAtMs - left.createdAtMs)
  .slice(0, MAX_VISIBLE_NOTICES);

const subscribeToNotificationFeed = ({
  tourId,
  userId,
  onUpdate,
  onError = () => {},
  db: dbOverride,
  auth: authOverride,
  cacheOwnerId = userId,
  readStateOwnerId = cacheOwnerId,
  cacheStorage = notificationCacheStorage,
  now = Date.now(),
}) => {
  const db = dbOverride || getFirebaseServices().realtimeDb;
  const safeTourId = requireSafeKey(normalizeTourId(tourId), 'tour id');
  const safeUserId = resolveInboxUserId(userId, authOverride);
  const safeCacheOwnerId = requireCacheScope(cacheOwnerId || safeUserId);
  const safeReadStateOwnerId = requireSafeKey(readStateOwnerId || safeCacheOwnerId, 'notification read-state owner id');
  if (!db || typeof onUpdate !== 'function') {
    throw new Error('Notification feed is unavailable');
  }

  requestNotificationReadStateMigration({
    tourId: safeTourId,
    userId: safeUserId,
    readStateOwnerId: safeReadStateOwnerId,
    db,
    auth: authOverride,
    now,
  }).catch(() => {});

  const noticesQuery = db.ref(`tour_notifications/${safeTourId}`)
    .orderByChild('createdAtMs')
    .limitToLast(MAX_VISIBLE_NOTICES);
  const readRef = db.ref(`notification_read_state/${safeTourId}/${safeReadStateOwnerId}`)
    .orderByValue()
    .limitToLast(MAX_READ_STATE_RECORDS);
  let noticeMap = {};
  let readState = {};
  let hasNotices = false;
  let hasReadState = false;
  let active = true;
  let liveEmissionCompleted = false;
  let latestItems = [];
  let hasPersistedCache = false;
  const cacheGenerationPromise = readNotificationCacheGeneration({
    userId: safeUserId,
    storage: cacheStorage,
  });

  const emit = () => {
    if (!active || !hasNotices || !hasReadState) return;
    const items = buildNotificationFeed(noticeMap, readState);
    liveEmissionCompleted = true;
    latestItems = items;
    onUpdate({
      items,
      unreadCount: items.filter((item) => !item.isRead).length,
      source: 'live',
      stale: false,
    });
    Promise.resolve(cacheGenerationPromise)
      .then((generation) => active ? persistNotificationFeedCache({
        tourId: safeTourId,
        userId: safeUserId,
        cacheOwnerId: safeCacheOwnerId,
        items,
        storage: cacheStorage,
        expectedGeneration: generation,
      }) : false)
      .then((saved) => {
        if (active && saved && cacheStorage?.health?.durable !== false) hasPersistedCache = true;
      })
      .catch(() => {});
  };
  const handleNotices = (snapshot) => {
    if (!active) return;
    noticeMap = snapshot?.val?.() || {};
    hasNotices = true;
    emit();
  };
  const handleReadState = (snapshot) => {
    if (!active) return;
    readState = snapshot?.val?.() || {};
    hasReadState = true;
    emit();
  };
  const handleError = (error) => {
    if (!active) return;
    onError(
      error instanceof Error ? error : new Error(String(error || 'Feed failed')),
      {
        items: latestItems,
        hasItems: latestItems.length > 0,
        hasCachedItems: hasPersistedCache,
        hasPersistedCache,
        stale: true,
      },
    );
  };

  Promise.resolve(cacheGenerationPromise).then((generation) => loadNotificationFeedCache({
    tourId: safeTourId,
    userId: safeUserId,
    cacheOwnerId: safeCacheOwnerId,
    generation,
    storage: cacheStorage,
    now,
  })).then((cached) => {
    if (!active || liveEmissionCompleted || !cached?.items?.length) return;
    latestItems = cached.items;
    hasPersistedCache = cacheStorage?.health?.durable !== false;
    onUpdate({
      items: cached.items,
      unreadCount: cached.items.filter((item) => !item.isRead).length,
      source: 'cache',
      stale: true,
      cachedAtMs: cached.cachedAtMs,
    });
  }).catch(() => {});

  noticesQuery.on('value', handleNotices, handleError);
  readRef.on('value', handleReadState, handleError);

  const unsubscribe = () => {
    if (!active) return;
    active = false;
    noticesQuery.off('value', handleNotices);
    readRef.off('value', handleReadState);
    const subscriptions = notificationFeedSubscriptions.get(safeUserId);
    subscriptions?.delete(unsubscribe);
    if (subscriptions?.size === 0) notificationFeedSubscriptions.delete(safeUserId);
  };
  const subscriptions = notificationFeedSubscriptions.get(safeUserId) || new Set();
  subscriptions.add(unsubscribe);
  notificationFeedSubscriptions.set(safeUserId, subscriptions);
  return unsubscribe;
};

const markNotificationRead = async ({
  tourId,
  userId,
  noticeId,
  readStateOwnerId = userId,
  db: dbOverride,
  auth: authOverride,
  now = Date.now(),
}) => {
  const db = dbOverride || getFirebaseServices().realtimeDb;
  const safeTourId = requireSafeKey(normalizeTourId(tourId), 'tour id');
  const safeUserId = resolveInboxUserId(userId, authOverride);
  const safeReadStateOwnerId = requireSafeKey(readStateOwnerId || safeUserId, 'notification read-state owner id');
  const safeNoticeId = requireSafeKey(noticeId, 'notice id');
  await db.ref(`notification_read_state/${safeTourId}/${safeReadStateOwnerId}/${safeNoticeId}`).set(now);
  return now;
};

const markAllNotificationsRead = async ({
  tourId,
  userId,
  noticeIds = [],
  readStateOwnerId = userId,
  db: dbOverride,
  auth: authOverride,
  now = Date.now(),
}) => {
  const db = dbOverride || getFirebaseServices().realtimeDb;
  const safeTourId = requireSafeKey(normalizeTourId(tourId), 'tour id');
  const safeUserId = resolveInboxUserId(userId, authOverride);
  const safeReadStateOwnerId = requireSafeKey(readStateOwnerId || safeUserId, 'notification read-state owner id');
  const uniqueNoticeIds = [...new Set(noticeIds.map((id) => requireSafeKey(id, 'notice id')))];
  if (uniqueNoticeIds.length === 0) return 0;
  const updates = {};
  uniqueNoticeIds.forEach((noticeId) => {
    updates[`notification_read_state/${safeTourId}/${safeReadStateOwnerId}/${noticeId}`] = now;
  });
  await db.ref().update(updates);
  return uniqueNoticeIds.length;
};

module.exports = {
  MAX_VISIBLE_NOTICES,
  MAX_READ_STATE_RECORDS,
  buildNotificationFeed,
  clearNotificationFeedCache,
  feedCacheKey,
  loadNotificationFeedCache,
  markAllNotificationsRead,
  markNotificationRead,
  normalizeTourNotice,
  parseCachedFeed,
  persistNotificationFeedCache,
  requestNotificationReadStateMigration,
  subscribeToNotificationFeed,
};
