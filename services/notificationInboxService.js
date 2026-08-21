const { parseTimestampMs } = require('./timeUtils');
const { normalizeTourId } = require('./tourIdentityService');

const MAX_VISIBLE_NOTICES = 50;
const ALLOWED_TYPES = new Set(['announcement', 'itinerary', 'driver_tour_pack']);
const ALLOWED_SCREENS = new Set(['Chat', 'Itinerary', 'DriverTourPack']);
const DRIVER_SECTIONS = new Set(['status', 'tour', 'pickups', 'passengers', 'seats', 'timeline', 'hotels', 'services', 'coach', 'contacts', 'itineraries', 'coverage', 'quality']);
const PII = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\+?\d[\d\s().-]{7,}\d)/i;

const requireSafeKey = (value, label) => {
  const normalized = String(value || '').trim();
  if (!normalized || /[.#$/\[\]]/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
};

const getFirebaseServices = () => require('../firebase');

const resolveInboxUserId = (candidate, authOverride) => {
  const auth = authOverride === undefined ? getFirebaseServices().auth : authOverride;
  const authUid = auth?.currentUser?.uid;
  return requireSafeKey(authUid || candidate, 'notification user id');
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
}) => {
  const db = dbOverride || getFirebaseServices().realtimeDb;
  const safeTourId = requireSafeKey(normalizeTourId(tourId), 'tour id');
  const safeUserId = resolveInboxUserId(userId, authOverride);
  if (!db || typeof onUpdate !== 'function') {
    throw new Error('Notification feed is unavailable');
  }

  const noticesQuery = db.ref(`tour_notifications/${safeTourId}`)
    .orderByChild('createdAtMs')
    .limitToLast(MAX_VISIBLE_NOTICES);
  const readRef = db.ref(`notification_read_state/${safeTourId}/${safeUserId}`);
  let noticeMap = {};
  let readState = {};
  let hasNotices = false;
  let hasReadState = false;

  const emit = () => {
    if (!hasNotices || !hasReadState) return;
    const items = buildNotificationFeed(noticeMap, readState);
    onUpdate({
      items,
      unreadCount: items.filter((item) => !item.isRead).length,
    });
  };
  const handleNotices = (snapshot) => {
    noticeMap = snapshot?.val?.() || {};
    hasNotices = true;
    emit();
  };
  const handleReadState = (snapshot) => {
    readState = snapshot?.val?.() || {};
    hasReadState = true;
    emit();
  };
  const handleError = (error) => onError(error instanceof Error ? error : new Error(String(error || 'Feed failed')));

  noticesQuery.on('value', handleNotices, handleError);
  readRef.on('value', handleReadState, handleError);

  return () => {
    noticesQuery.off('value', handleNotices);
    readRef.off('value', handleReadState);
  };
};

const markNotificationRead = async ({
  tourId,
  userId,
  noticeId,
  db: dbOverride,
  auth: authOverride,
  now = Date.now(),
}) => {
  const db = dbOverride || getFirebaseServices().realtimeDb;
  const safeTourId = requireSafeKey(normalizeTourId(tourId), 'tour id');
  const safeUserId = resolveInboxUserId(userId, authOverride);
  const safeNoticeId = requireSafeKey(noticeId, 'notice id');
  await db.ref(`notification_read_state/${safeTourId}/${safeUserId}/${safeNoticeId}`).set(now);
  return now;
};

const markAllNotificationsRead = async ({
  tourId,
  userId,
  noticeIds = [],
  db: dbOverride,
  auth: authOverride,
  now = Date.now(),
}) => {
  const db = dbOverride || getFirebaseServices().realtimeDb;
  const safeTourId = requireSafeKey(normalizeTourId(tourId), 'tour id');
  const safeUserId = resolveInboxUserId(userId, authOverride);
  const uniqueNoticeIds = [...new Set(noticeIds.map((id) => requireSafeKey(id, 'notice id')))];
  if (uniqueNoticeIds.length === 0) return 0;
  const updates = {};
  uniqueNoticeIds.forEach((noticeId) => {
    updates[`notification_read_state/${safeTourId}/${safeUserId}/${noticeId}`] = now;
  });
  await db.ref().update(updates);
  return uniqueNoticeIds.length;
};

module.exports = {
  MAX_VISIBLE_NOTICES,
  buildNotificationFeed,
  markAllNotificationsRead,
  markNotificationRead,
  normalizeTourNotice,
  subscribeToNotificationFeed,
};
