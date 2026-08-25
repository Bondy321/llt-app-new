// services/photoService.js
// Production-ready photo service using server-mediated Storage and Realtime Database metadata
// Enhanced with comprehensive validation, file type checking, and size limits

const {
  ref: databaseRef,
  remove,
  serverTimestamp,
  onValue,
  get,
  update,
  query,
  orderByChild,
  limitToLast,
  endAt,
} = require('firebase/database');
const { realtimeDbModular, auth, getCurrentAppCheckToken } = require('../../firebase');
const { normalizePhotoUri } = require('../photoVariantService');
const { loadOptionalService } = require('../optionalServiceLoader');
const { assertTextPassesModeration } = require('../contentModerationService');

const loggerServiceModule = loadOptionalService({
  modulePath: '../loggerService',
  loadModule: () => require('../loggerService'),
  serviceLabel: 'Logger service',
});
const logger = loggerServiceModule?.default || loggerServiceModule;

// ==================== CONSTANTS ====================

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
const MAX_CAPTION_LENGTH = 500;
const LIVE_PHOTOS_WINDOW = 100;
const PHOTO_CACHE_CONTROL_HEADER = 'private,max-age=300,no-transform';
const IDEMPOTENCY_KEY_MAX_LENGTH = 180;
const PRIVATE_MEDIA_BATCH_LIMIT = 50;
const PRIVATE_MEDIA_FUNCTION_NAME = 'resolvePrivatePhotoMedia';
const PRIVATE_UPLOAD_FUNCTION_NAME = 'uploadPrivatePhoto';
const PRIVATE_DELETE_FUNCTION_NAME = 'deletePrivatePhoto';
const GROUP_MEDIA_FUNCTION_NAME = 'resolveGroupPhotoMedia';
const GROUP_UPLOAD_FUNCTION_NAME = 'uploadGroupPhoto';
const GROUP_DELETE_FUNCTION_NAME = 'deleteGroupPhoto';

const summarizeUriForDbLog = (uri) => {
  if (typeof uri !== 'string' || !uri.trim()) {
    return { present: false };
  }

  const normalized = uri.trim();
  const schemeMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return {
    present: true,
    scheme: schemeMatch?.[1]?.toLowerCase() || 'unknown',
    totalLength: normalized.length,
  };
};

const summarizeErrorForDbLog = (error) => ({
  name: error?.name || 'Error',
  code: typeof error?.code === 'string' ? error.code : null,
  message: error?.message || String(error),
});

const logPhotoDbEvent = (level, eventName, payload = {}) => {
  try {
    const persistLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    if (logger && typeof logger[persistLevel] === 'function') {
      logger[persistLevel]('PhotoService', eventName, payload);
    }
  } catch (_error) {
    // Realtime database diagnostics must never affect photo behavior.
  }
};

const stableHash = (value) => {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const summarizePathForDbLog = (path) => {
  if (typeof path !== 'string' || !path.trim()) {
    return { present: false };
  }

  const normalized = path.trim();
  return {
    present: true,
    length: normalized.length,
    segmentCount: normalized.split('/').filter(Boolean).length,
    hash: stableHash(normalized),
    containsEncodedDot: normalized.includes('_2E_'),
  };
};

const summarizePrincipalForDbLog = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    return { present: false };
  }

  const normalized = value.trim();
  return {
    present: true,
    length: normalized.length,
    hash: stableHash(normalized),
    isRealtimeSafe: !/[.#$\/\[\]\x00-\x1F\x7F]/.test(normalized),
    containsEmailSeparator: normalized.includes('@') || normalized.includes('_40_'),
  };
};

const sanitizeStorageSegment = (value, fallback = 'photo') => {
  if (typeof value !== 'string') return fallback;
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
  return sanitized || fallback;
};

const resolveRealtimeTimestamp = (serverTimestampFn, nowFn = Date.now) => {
  try {
    const candidate = typeof serverTimestampFn === 'function' ? serverTimestampFn() : null;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  } catch (_error) {
    // Fall back to a client timestamp when the SDK placeholder cannot be serialized as a number.
  }

  const fallback = nowFn();
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : Date.now();
};

// ==================== PAGINATION HELPERS ====================

/**
 * Normalizes mixed timestamp values into a safe numeric millisecond value.
 * Supports numbers, numeric strings, Date instances, and known timestamp-like objects.
 * Missing/unsupported values are normalized to 0 so ordering remains deterministic.
 * @param {unknown} rawTimestamp
 * @returns {number}
 */
const normalizeTimestamp = (rawTimestamp) => {
  if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
    return rawTimestamp;
  }

  if (typeof rawTimestamp === 'string') {
    const asNumber = Number(rawTimestamp);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
  }

  if (rawTimestamp instanceof Date && Number.isFinite(rawTimestamp.getTime())) {
    return rawTimestamp.getTime();
  }

  if (rawTimestamp && typeof rawTimestamp === 'object') {
    if (typeof rawTimestamp.toMillis === 'function') {
      const millis = rawTimestamp.toMillis();
      if (Number.isFinite(millis)) {
        return millis;
      }
    }

    if (typeof rawTimestamp.seconds === 'number') {
      const millis = rawTimestamp.seconds * 1000;
      if (Number.isFinite(millis)) {
        return millis;
      }
    }

    if (typeof rawTimestamp._seconds === 'number') {
      const millis = rawTimestamp._seconds * 1000;
      if (Number.isFinite(millis)) {
        return millis;
      }
    }

    if (typeof rawTimestamp.timestamp === 'number') {
      return rawTimestamp.timestamp;
    }
  }

  return 0;
};

const sanitizePageLimit = (limit) => {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30;
  }
  return Math.min(parsed, 100);
};

const normalizeCursor = (endBefore) => {
  if (endBefore == null) {
    return null;
  }

  if (typeof endBefore === 'number' || typeof endBefore === 'string') {
    const timestamp = normalizeTimestamp(endBefore);
    if (timestamp <= 0) {
      return null;
    }
    return { timestamp, id: null };
  }

  if (typeof endBefore === 'object') {
    const timestamp = normalizeTimestamp(endBefore.timestamp);
    if (timestamp <= 0) {
      return null;
    }
    const id = typeof endBefore.id === 'string' && endBefore.id.length > 0 ? endBefore.id : null;
    return { timestamp, id };
  }

  return null;
};

const normalizeOptionalString = (value) => {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeOptionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizePhotoRecordForClient = (id, value, extras = {}) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const photo = {
    ...source,
    ...extras,
    id,
    timestamp: normalizeTimestamp(source?.timestamp),
  };

  ['sourceUrl', 'thumbnailUrl', 'viewerUrl'].forEach((field) => {
    const uri = normalizePhotoUri(source?.[field]);
    if (uri) {
      photo[field] = uri;
    } else {
      delete photo[field];
    }
  });

  [
    'userId',
    'caption',
    'uploaderName',
    'storagePath',
    'thumbnailStoragePath',
    'viewerStoragePath',
    'fileType',
    'idempotencyKey',
    'variantStatus',
    'variantError',
    'captionEditedBy',
  ].forEach((field) => {
    const normalized = normalizeOptionalString(source?.[field]);
    if (normalized) {
      photo[field] = normalized;
    } else {
      delete photo[field];
    }
  });

  ['fileSize', 'variantUpdatedAt', 'variantVersion', 'captionUpdatedAt'].forEach((field) => {
    const normalized = normalizeOptionalNumber(source?.[field]);
    if (normalized !== null) {
      photo[field] = normalized;
    } else {
      delete photo[field];
    }
  });

  return photo;
};

const mapSnapshotToPhotos = (snapshot, extras = {}) => {
  const data = snapshot.val() || {};
  return Object.entries(data).map(([id, value]) => normalizePhotoRecordForClient(id, value, extras));
};

const sortPhotosDescending = (photos) => {
  photos.sort((a, b) => {
    if (b.timestamp !== a.timestamp) {
      return b.timestamp - a.timestamp;
    }

    return b.id.localeCompare(a.id);
  });
};

const buildPagedPhotoResult = (photos, limit) => {
  sortPhotosDescending(photos);

  const hasMore = photos.length > limit;
  const items = hasMore ? photos.slice(0, limit) : photos;
  const lastItem = items[items.length - 1] || null;

  return {
    items,
    nextCursor: lastItem ? { timestamp: lastItem.timestamp, id: lastItem.id } : null,
    hasMore,
  };
};

/**
 * Fetches a bounded page of group tour photos ordered by timestamp descending.
 *
 * Input contract:
 * - tourId: required non-empty string
 * - limit: optional positive integer (default 30, max 100)
 * - endBefore: optional cursor ({ timestamp, id }) or timestamp value
 *
 * Output contract:
 * - { items, nextCursor, hasMore }
 * - empty datasets return { items: [], nextCursor: null, hasMore: false }
 * - missing/invalid timestamps are normalized to 0 for deterministic ordering
 *
 * @param {{ tourId: string, limit?: number, endBefore?: ({ timestamp: unknown, id?: string }|number|string|null) }} params
 * @param {Object} [deps]
 * @returns {Promise<{ items: Array<Object>, nextCursor: ({ timestamp: number, id: string }|null), hasMore: boolean }>}
 */

module.exports = {
  ALLOWED_IMAGE_TYPES,
  GROUP_DELETE_FUNCTION_NAME,
  GROUP_MEDIA_FUNCTION_NAME,
  GROUP_UPLOAD_FUNCTION_NAME,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  LIVE_PHOTOS_WINDOW,
  MAX_CAPTION_LENGTH,
  MAX_FILE_SIZE,
  PHOTO_CACHE_CONTROL_HEADER,
  PRIVATE_DELETE_FUNCTION_NAME,
  PRIVATE_MEDIA_FUNCTION_NAME,
  PRIVATE_MEDIA_BATCH_LIMIT,
  PRIVATE_UPLOAD_FUNCTION_NAME,
  assertTextPassesModeration,
  auth,
  buildPagedPhotoResult,
  databaseRef,
  endAt,
  get,
  getCurrentAppCheckToken,
  limitToLast,
  logPhotoDbEvent,
  mapSnapshotToPhotos,
  normalizeCursor,
  normalizeOptionalNumber,
  normalizeOptionalString,
  normalizePhotoRecordForClient,
  normalizePhotoUri,
  normalizeTimestamp,
  onValue,
  orderByChild,
  query,
  realtimeDbModular,
  remove,
  resolveRealtimeTimestamp,
  sanitizePageLimit,
  sanitizeStorageSegment,
  serverTimestamp,
  sortPhotosDescending,
  stableHash,
  summarizeErrorForDbLog,
  summarizePathForDbLog,
  summarizePrincipalForDbLog,
  summarizeUriForDbLog,
  update,
};
