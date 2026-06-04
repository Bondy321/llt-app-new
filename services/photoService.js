// services/photoService.js
// Production-ready photo service using Firebase Storage and Realtime Database
// Enhanced with comprehensive validation, file type checking, and size limits

const {
  ref: storageRef,
  uploadBytes,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} = require('firebase/storage');
const {
  ref: databaseRef,
  push,
  set,
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
const { storage, realtimeDbModular, auth } = require('../firebase');
const { normalizePhotoUri } = require('./photoVariantService');
const { loadOptionalService } = require('./optionalServiceLoader');

const loggerServiceModule = loadOptionalService({
  modulePath: './loggerService',
  loadModule: () => require('./loggerService'),
  serviceLabel: 'Logger service',
});
const logger = loggerServiceModule?.default || loggerServiceModule;

// ==================== CONSTANTS ====================

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
const MAX_CAPTION_LENGTH = 500;
const LIVE_PHOTOS_WINDOW = 100;
const PHOTO_CACHE_CONTROL_HEADER = 'public,max-age=31536000,immutable';
const DOWNLOAD_URL_RETRYABLE_CODES = new Set([
  'storage/object-not-found',
  'storage/retry-limit-exceeded',
  'storage/unknown',
]);
const IDEMPOTENCY_KEY_MAX_LENGTH = 180;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  } catch (error) {
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
  } catch (error) {
    // Fall back to a client timestamp when the SDK placeholder cannot be serialized as a number.
  }

  const fallback = nowFn();
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : Date.now();
};

const getDownloadUrlWithRetry = async (getDownloadURLFn, fileRef, { maxAttempts = 5, initialDelayMs = 200 } = {}) => {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      return await getDownloadURLFn(fileRef);
    } catch (error) {
      lastError = error;
      const code = typeof error?.code === 'string' ? error.code : null;
      const retryableByCode = code && DOWNLOAD_URL_RETRYABLE_CODES.has(code);
      const retryableByMessage = typeof error?.message === 'string' && /network|timeout|timed out|object-not-found/i.test(error.message);

      attempt += 1;
      if (attempt >= maxAttempts || (!retryableByCode && !retryableByMessage)) {
        break;
      }

      const delay = initialDelayMs * (2 ** (attempt - 1));
      await sleep(Math.min(delay, 2000));
    }
  }

  throw lastError || new Error('Failed to resolve photo URL');
};

const deleteStoredPhotoObject = async ({
  storageInstance,
  storageRefFn,
  deleteObjectFn,
  path,
  label,
  timeoutMs = 10000,
}) => {
  const storagePath = typeof path === 'string' ? path.trim() : '';
  if (!storagePath) return;

  try {
    logPhotoDbEvent('debug', 'photo_storage_delete_start', {
      label,
      path: summarizePathForDbLog(storagePath),
      timeoutMs,
    });
    const fileRef = storageRefFn(storageInstance, storagePath);
    await Promise.race([
      deleteObjectFn(fileRef),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} deletion timeout`)), timeoutMs)
      ),
    ]);
    logPhotoDbEvent('debug', 'photo_storage_delete_success', {
      label,
      path: summarizePathForDbLog(storagePath),
    });
  } catch (error) {
    logPhotoDbEvent('warn', 'photo_storage_delete_failed', {
      label,
      path: summarizePathForDbLog(storagePath),
      error: summarizeErrorForDbLog(error),
    });
  }
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
const fetchTourPhotosPage = async (
  { tourId, limit = 30, endBefore = null },
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
    endAtFn = endAt,
    getFn = get,
  } = {},
) => {
  const validatedTourId = validateTourId(tourId);
  const safeLimit = sanitizePageLimit(limit);
  const cursor = normalizeCursor(endBefore);

  const baseRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${validatedTourId}`);
  const constraints = [orderByChildFn('timestamp')];
  if (cursor) {
    constraints.push(endAtFn(cursor.timestamp, cursor.id || undefined));
  }
  constraints.push(limitToLastFn(safeLimit + 1));

  logPhotoDbEvent('debug', 'photo_page_fetch_start', {
    visibility: 'group',
    tourId: summarizePrincipalForDbLog(validatedTourId),
    limit: safeLimit,
    hasCursor: Boolean(cursor),
    cursor: cursor
      ? {
          timestamp: cursor.timestamp,
          id: summarizePrincipalForDbLog(cursor.id),
        }
      : null,
  });
  const snapshot = await getFn(queryFn(baseRef, ...constraints));
  const photos = mapSnapshotToPhotos(snapshot).filter((photo) => {
    if (!cursor) {
      return true;
    }
    return !(photo.timestamp === cursor.timestamp && (!cursor.id || photo.id === cursor.id));
  });

  const result = buildPagedPhotoResult(photos, safeLimit);
  logPhotoDbEvent('debug', 'photo_page_fetch_success', {
    visibility: 'group',
    tourId: summarizePrincipalForDbLog(validatedTourId),
    returnedCount: result.items.length,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor
      ? {
          timestamp: result.nextCursor.timestamp,
          id: summarizePrincipalForDbLog(result.nextCursor.id),
        }
      : null,
  });
  return result;
};

/**
 * Fetches a bounded page of private photos for a user ordered by timestamp descending.
 *
 * Input contract:
 * - tourId: required non-empty string
 * - ownerId: required non-empty string
 * - limit: optional positive integer (default 30, max 100)
 * - endBefore: optional cursor ({ timestamp, id }) or timestamp value
 *
 * Output contract:
 * - { items, nextCursor, hasMore }
 * - empty datasets return { items: [], nextCursor: null, hasMore: false }
 * - missing/invalid timestamps are normalized to 0 for deterministic ordering
 *
 * @param {{ tourId: string, ownerId: string, limit?: number, endBefore?: ({ timestamp: unknown, id?: string }|number|string|null) }} params
 * @param {Object} [deps]
 * @returns {Promise<{ items: Array<Object>, nextCursor: ({ timestamp: number, id: string }|null), hasMore: boolean }>}
 */
const fetchPrivatePhotosPage = async (
  { tourId, ownerId, limit = 30, endBefore = null },
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
    endAtFn = endAt,
    getFn = get,
  } = {},
) => {
  const validatedTourId = validateTourId(tourId);
  const validatedOwnerId = validateUserId(ownerId);
  const validatedOwnerKey = sanitizeRealtimeKeySegment(validatedOwnerId);
  const safeLimit = sanitizePageLimit(limit);
  const cursor = normalizeCursor(endBefore);

  const baseRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${validatedTourId}/${validatedOwnerKey}`);
  const constraints = [orderByChildFn('timestamp')];
  if (cursor) {
    constraints.push(endAtFn(cursor.timestamp, cursor.id || undefined));
  }
  constraints.push(limitToLastFn(safeLimit + 1));

  logPhotoDbEvent('debug', 'photo_page_fetch_start', {
    visibility: 'private',
    tourId: summarizePrincipalForDbLog(validatedTourId),
    ownerId: summarizePrincipalForDbLog(validatedOwnerId),
    ownerKey: summarizePrincipalForDbLog(validatedOwnerKey),
    limit: safeLimit,
    hasCursor: Boolean(cursor),
    cursor: cursor
      ? {
          timestamp: cursor.timestamp,
          id: summarizePrincipalForDbLog(cursor.id),
        }
      : null,
  });
  const snapshot = await getFn(queryFn(baseRef, ...constraints));
  const photos = mapSnapshotToPhotos(snapshot).filter((photo) => {
    if (!cursor) {
      return true;
    }
    return !(photo.timestamp === cursor.timestamp && (!cursor.id || photo.id === cursor.id));
  });

  const result = buildPagedPhotoResult(photos, safeLimit);
  logPhotoDbEvent('debug', 'photo_page_fetch_success', {
    visibility: 'private',
    tourId: summarizePrincipalForDbLog(validatedTourId),
    ownerId: summarizePrincipalForDbLog(validatedOwnerId),
    ownerKey: summarizePrincipalForDbLog(validatedOwnerKey),
    returnedCount: result.items.length,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor
      ? {
          timestamp: result.nextCursor.timestamp,
          id: summarizePrincipalForDbLog(result.nextCursor.id),
        }
      : null,
  });
  return result;
};

// ==================== VALIDATION HELPERS ====================

/**
 * Validates tour ID
 */
const validateTourId = (tourId) => {
  if (!tourId || typeof tourId !== 'string' || tourId.trim().length === 0) {
    throw new Error('Invalid tour ID');
  }
  return tourId.trim();
};

/**
 * Validates user ID
 */
const validateUserId = (userId) => {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Invalid user ID');
  }
  return userId.trim();
};

const sanitizeRealtimeKeySegment = (value) => (
  value.replace(/[.#$/\[\]\x00-\x1F\x7F]/g, (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`)
);

/**
 * Validates photo ID
 */
const validatePhotoId = (photoId) => {
  if (!photoId || typeof photoId !== 'string' || photoId.trim().length === 0) {
    throw new Error('Invalid photo ID');
  }
  return photoId.trim();
};

/**
 * Validates file URI
 */
const validateUri = (uri) => {
  if (!uri || typeof uri !== 'string' || uri.trim().length === 0) {
    throw new Error('Invalid file URI');
  }
  return uri.trim();
};

/**
 * Validates visibility setting
 */
const validateVisibility = (visibility) => {
  if (visibility && visibility !== 'group' && visibility !== 'private') {
    throw new Error('Visibility must be either "group" or "private"');
  }
  return visibility || 'group';
};

/**
 * Validates caption
 */
const validateCaption = (caption) => {
  if (caption && typeof caption !== 'string') {
    throw new Error('Caption must be a string');
  }

  const trimmed = (caption || '').trim();
  if (trimmed.length > MAX_CAPTION_LENGTH) {
    throw new Error(`Caption exceeds maximum length of ${MAX_CAPTION_LENGTH} characters`);
  }

  return trimmed;
};

/**
 * Validates blob and checks file type and size
 */
const validateBlob = (blob) => {
  if (!blob) {
    throw new Error('Invalid file blob');
  }

  // Check file size
  if (blob.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds maximum of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }

  // Check file type
  if (!ALLOWED_IMAGE_TYPES.includes(blob.type)) {
    throw new Error(`File type ${blob.type} is not supported. Allowed types: ${ALLOWED_IMAGE_TYPES.join(', ')}`);
  }

  return blob;
};

// ==================== BLOB HANDLING ====================

const createBlob = async (uri, fetchFn = fetch) => {
  const response = await fetchFn(uri);

  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.statusText}`);
  }

  const blob = await response.blob();
  return blob;
};

const uploadPhoto = async (
  uri,
  tourId,
  userId,
  caption = '',
  {
    visibility = 'group',
    uploaderName = 'Tour Member',
    storageInstance = storage,
    authInstance = auth,
    realtimeDbInstance = realtimeDbModular,
    storageRefFn = storageRef,
    uploadBytesFn = uploadBytes,
    uploadBytesResumableFn = uploadBytesResumable,
    getDownloadURLFn = getDownloadURL,
    dbRefFn = databaseRef,
    pushFn = push,
    setFn = set,
    getFn = get,
    serverTimestampFn = serverTimestamp,
    fetchFn = fetch,
    onProgress = null,
    optimizationMetrics = null,
    idempotencyKey = null,
    nowFn = Date.now,
  } = {}
) => {
  let uploadStage = 'initializing';
  let uploadDiagnostics = {};

  try {
    // Validate inputs
    uploadStage = 'validating_inputs';
    const validatedUri = validateUri(uri);
    const validatedTourId = validateTourId(tourId);
    const validatedUserId = validateUserId(userId);
    const validatedUserKey = sanitizeRealtimeKeySegment(validatedUserId);
    const validatedCaption = validateCaption(caption);
    const validatedVisibility = validateVisibility(visibility);
    const normalizedIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.trim()
      ? idempotencyKey.trim().slice(0, IDEMPOTENCY_KEY_MAX_LENGTH)
      : null;

    if (!storageInstance) {
      throw new Error('Storage instance not initialized');
    }

    if (!realtimeDbInstance) {
      throw new Error('Database instance not initialized');
    }

    const authUid = typeof authInstance?.currentUser?.uid === 'string' && authInstance.currentUser.uid.trim()
      ? authInstance.currentUser.uid.trim()
      : null;
    if (!authUid) {
      throw new Error('Authenticated user required for photo upload');
    }

    const isPrivate = validatedVisibility === 'private';
    uploadDiagnostics = {
      visibility: validatedVisibility,
      tourId: summarizePrincipalForDbLog(validatedTourId),
      userId: summarizePrincipalForDbLog(validatedUserId),
      ownerKey: summarizePrincipalForDbLog(validatedUserKey),
      ownerKeyMatchesUserId: validatedUserKey === validatedUserId,
      hasIdempotencyKey: Boolean(normalizedIdempotencyKey),
      idempotencyKey: summarizePrincipalForDbLog(normalizedIdempotencyKey),
      uri: summarizeUriForDbLog(validatedUri),
    };
    logPhotoDbEvent('info', 'photo_upload_start', uploadDiagnostics);

    // Create blob and validate
    uploadStage = 'fetching_source_blob';
    const blob = await createBlob(validatedUri, fetchFn);
    uploadStage = 'validating_source_blob';
    validateBlob(blob);
    uploadDiagnostics = {
      ...uploadDiagnostics,
      fileType: blob.type || null,
      fileSize: typeof blob.size === 'number' ? blob.size : null,
    };

    // Determine file extension from blob type
    const extensionMap = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/heic': 'heic',
    };
    const extension = extensionMap[blob.type] || 'jpg';

    const uploadTimestamp = Date.now();
    const deterministicSegment = normalizedIdempotencyKey
      ? sanitizeStorageSegment(normalizedIdempotencyKey, `${uploadTimestamp}_${validatedUserId}`)
      : sanitizeStorageSegment(`${uploadTimestamp}_${validatedUserId}`, `${uploadTimestamp}_photo`);
    const filename = `${deterministicSegment}.${extension}`;
    const storagePath = isPrivate
      ? `private_tour_photos/${validatedTourId}/${validatedUserKey}/${filename}`
      : `group_tour_photos/${validatedTourId}/${filename}`;
    uploadDiagnostics = {
      ...uploadDiagnostics,
      storagePath: summarizePathForDbLog(storagePath),
    };
    const fileRef = storageRefFn(storageInstance, storagePath);

    try {
      const metadata = {
        contentType: blob.type,
        cacheControl: PHOTO_CACHE_CONTROL_HEADER,
        customMetadata: {
          uploadedBy: validatedUserId,
          authUid,
          uploadedAt: new Date().toISOString(),
          idempotencyKey: normalizedIdempotencyKey || '',
          tourId: validatedTourId,
          visibility: validatedVisibility,
          ownerKey: validatedUserKey,
          sourceRole: 'source',
        },
      };

      const uploadWithProgress = () => new Promise((resolve, reject) => {
        try {
          if (typeof uploadBytesResumableFn !== 'function' || typeof onProgress !== 'function') {
            resolve(uploadBytesFn(fileRef, blob, metadata));
            return;
          }

          const uploadTask = uploadBytesResumableFn(fileRef, blob, metadata);
          uploadTask.on('state_changed', (snapshot) => {
            if (snapshot.totalBytes > 0) {
              onProgress(snapshot.bytesTransferred / snapshot.totalBytes);
            }
          }, reject, () => resolve(uploadTask.snapshot));
        } catch (error) {
          reject(error);
        }
      });

      uploadStage = 'uploading_source_to_storage';
      logPhotoDbEvent('debug', 'photo_upload_storage_source_start', uploadDiagnostics);
      await Promise.race([
        uploadWithProgress(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Photo upload timeout')), 60000)
        ),
      ]);
      logPhotoDbEvent('info', 'photo_upload_storage_source_written', uploadDiagnostics);

      uploadStage = 'resolving_source_download_url';
      const downloadURL = await getDownloadUrlWithRetry(getDownloadURLFn, fileRef);
      logPhotoDbEvent('debug', 'photo_upload_source_url_resolved', {
        ...uploadDiagnostics,
        downloadUrl: summarizeUriForDbLog(downloadURL),
      });

      const databasePath = isPrivate
        ? `private_tour_photos/${validatedTourId}/${validatedUserKey}`
        : `group_tour_photos/${validatedTourId}`;
      uploadDiagnostics = {
        ...uploadDiagnostics,
        databasePath: summarizePathForDbLog(databasePath),
      };
      const photosRef = dbRefFn(realtimeDbInstance, databasePath);
      if (normalizedIdempotencyKey) {
        uploadStage = 'checking_existing_photo_idempotency';
        logPhotoDbEvent('debug', 'photo_upload_db_lookup_start', uploadDiagnostics);
        const existingSnapshot = await getFn(photosRef);
        const existingData = existingSnapshot.val() || {};
        const existingEntry = Object.entries(existingData).find(([, value]) => value?.idempotencyKey === normalizedIdempotencyKey);
        if (existingEntry) {
          const [existingId, existingPhoto] = existingEntry;
          logPhotoDbEvent('info', 'photo_upload_deduped_existing_record', {
            ...uploadDiagnostics,
            photoId: summarizePrincipalForDbLog(existingId),
          });
          return {
            id: existingId,
            sourceUrl: existingPhoto.sourceUrl || null,
            userId: existingPhoto.userId || validatedUserId,
            caption: existingPhoto.caption || validatedCaption,
            uploaderName: existingPhoto.uploaderName || uploaderName || 'Tour Member',
            deduped: true,
          };
        }
      }

      const newPhotoRef = pushFn(photosRef);

      const photoData = {
        sourceUrl: downloadURL,
        userId: validatedUserId,
        caption: validatedCaption,
        timestamp: resolveRealtimeTimestamp(serverTimestampFn, nowFn),
        storagePath,
        fileSize: blob.size,
        fileType: blob.type,
        idempotencyKey: normalizedIdempotencyKey,
        variantStatus: 'processing',
        variantUpdatedAt: nowFn(),
        variantError: null,
        variantVersion: 2,
      };

      if (optimizationMetrics && typeof optimizationMetrics === 'object') {
        photoData.optimization = {
          originalSizeBytes: optimizationMetrics.originalSizeBytes || null,
          optimizedSizeBytes: optimizationMetrics.optimizedSizeBytes || blob.size,
          viewerSizeBytes: optimizationMetrics.viewerSizeBytes || null,
          thumbnailSizeBytes: optimizationMetrics.thumbnailSizeBytes || null,
          optimizationRatio: optimizationMetrics.optimizationRatio ?? null,
          viewerOptimizationRatio: optimizationMetrics.viewerOptimizationRatio ?? null,
        };
      }

      // Add uploader name for group photos
      if (!isPrivate && uploaderName) {
        photoData.uploaderName = uploaderName.trim();
      }

      uploadStage = 'writing_photo_record_to_database';
      logPhotoDbEvent('debug', 'photo_upload_db_write_start', {
        ...uploadDiagnostics,
        photoId: summarizePrincipalForDbLog(newPhotoRef?.key),
        photoDataKeys: Object.keys(photoData),
      });
      await setFn(newPhotoRef, photoData);
      uploadStage = 'completed';
      logPhotoDbEvent('info', 'photo_upload_db_write_success', {
        ...uploadDiagnostics,
        photoId: summarizePrincipalForDbLog(newPhotoRef?.key),
        variantStatus: photoData.variantStatus,
      });

      return {
        id: newPhotoRef.key,
        sourceUrl: downloadURL,
        userId: validatedUserId,
        caption: validatedCaption,
        uploaderName: uploaderName || 'Tour Member',
      };
    } finally {
      // Clean up blob
      if (blob && typeof blob.close === 'function') {
        try {
          blob.close();
        } catch (error) {
          logPhotoDbEvent('warn', 'photo_upload_blob_close_failed', {
            stage: uploadStage,
            error: summarizeErrorForDbLog(error),
          });
        }
      }

    }
  } catch (error) {
    logPhotoDbEvent('error', 'photo_upload_failed', {
      stage: uploadStage,
      diagnostics: uploadDiagnostics,
      tourId: summarizePrincipalForDbLog(typeof tourId === 'string' ? tourId.trim() : null),
      userId: summarizePrincipalForDbLog(typeof userId === 'string' ? userId.trim() : null),
      visibility,
      captionLength: typeof caption === 'string' ? caption.trim().length : 0,
      uri: summarizeUriForDbLog(uri),
      error: summarizeErrorForDbLog(error),
    });
    throw error;
  }
};

const subscribeToTourPhotos = (
  tourId,
  callback,
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    onValueFn = onValue,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
    limit = LIVE_PHOTOS_WINDOW,
  } = {}
) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);

    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }

    if (!realtimeDbInstance) {
      logPhotoDbEvent('warn', 'photo_subscription_db_unavailable', {
        visibility: 'group',
        tourId: summarizePrincipalForDbLog(validatedTourId),
      });
      return () => {};
    }

    const photosRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${validatedTourId}`);
    const liveLimit = sanitizePageLimit(limit || LIVE_PHOTOS_WINDOW);
    const photosQuery = queryFn(photosRef, orderByChildFn('timestamp'), limitToLastFn(liveLimit));

    logPhotoDbEvent('debug', 'photo_subscription_start', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(validatedTourId),
      liveLimit,
    });
    const unsubscribe = onValueFn(photosQuery, (snapshot) => {
      try {
        const photos = mapSnapshotToPhotos(snapshot);
        sortPhotosDescending(photos);
        logPhotoDbEvent('debug', 'photo_subscription_snapshot', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
          photoCount: photos.length,
          sample: photos.slice(0, 5).map((photo) => ({
            id: summarizePrincipalForDbLog(photo.id),
            timestamp: photo.timestamp || null,
            userId: summarizePrincipalForDbLog(photo.userId),
            variantStatus: photo.variantStatus || null,
            hasThumbnail: Boolean(photo.thumbnailUrl),
            hasViewer: Boolean(photo.viewerUrl),
          })),
        });
        callback(photos);
      } catch (error) {
        logPhotoDbEvent('error', 'photo_subscription_snapshot_processing_failed', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
          error: summarizeErrorForDbLog(error),
        });
        callback([]); // Provide empty array as fallback
      }
    }, (error) => {
      logPhotoDbEvent('error', 'photo_subscription_failed', {
        visibility: 'group',
        tourId: summarizePrincipalForDbLog(validatedTourId),
        error: summarizeErrorForDbLog(error),
      });
      callback([]); // Provide empty array on error
    });

    return () => {
      try {
        logPhotoDbEvent('debug', 'photo_subscription_stop', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
        });
        unsubscribe();
      } catch (error) {
        logPhotoDbEvent('warn', 'photo_subscription_unsubscribe_failed', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
          error: summarizeErrorForDbLog(error),
        });
      }
    };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_subscription_setup_failed', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(tourId),
      error: summarizeErrorForDbLog(error),
    });
    return () => {};
  }
};

const subscribeToPrivatePhotos = (
  tourId,
  ownerId,
  callback,
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    onValueFn = onValue,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
    limit = LIVE_PHOTOS_WINDOW,
  } = {},
) => {
  try {
    if (!tourId || !ownerId || typeof callback !== 'function') {
      logPhotoDbEvent('warn', 'photo_subscription_private_skipped_invalid_args', {
        hasTourId: Boolean(tourId),
        hasOwnerId: Boolean(ownerId),
        hasCallback: typeof callback === 'function',
      });
      return () => {};
    }

    if (!realtimeDbInstance) {
      logPhotoDbEvent('warn', 'photo_subscription_db_unavailable', {
        visibility: 'private',
        tourId: summarizePrincipalForDbLog(tourId),
        ownerId: summarizePrincipalForDbLog(ownerId),
      });
      return () => {};
    }

    const ownerScope = ownerId.trim();
    if (!ownerScope) {
      logPhotoDbEvent('warn', 'photo_subscription_private_skipped_empty_owner', {
        tourId: summarizePrincipalForDbLog(tourId),
      });
      return () => {};
    }
    const ownerScopeKey = sanitizeRealtimeKeySegment(ownerScope);

    const photosRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${tourId}/${ownerScopeKey}`);
    const liveLimit = sanitizePageLimit(limit || LIVE_PHOTOS_WINDOW);
    const photosQuery = queryFn(photosRef, orderByChildFn('timestamp'), limitToLastFn(liveLimit));

    logPhotoDbEvent('debug', 'photo_subscription_start', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerScope),
      ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
      liveLimit,
    });

    const unsubscribe = onValueFn(photosQuery, (snapshot) => {
      try {
        const photos = mapSnapshotToPhotos(snapshot, { ownerScope });
        sortPhotosDescending(photos);
        logPhotoDbEvent('debug', 'photo_subscription_snapshot', {
          visibility: 'private',
          tourId: summarizePrincipalForDbLog(tourId),
          ownerId: summarizePrincipalForDbLog(ownerScope),
          ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
          photoCount: photos.length,
          sample: photos.slice(0, 5).map((photo) => ({
            id: summarizePrincipalForDbLog(photo.id),
            timestamp: photo.timestamp || null,
            userId: summarizePrincipalForDbLog(photo.userId),
            privateOwnerId: summarizePrincipalForDbLog(photo.privateOwnerId),
            variantStatus: photo.variantStatus || null,
            hasThumbnail: Boolean(photo.thumbnailUrl),
            hasViewer: Boolean(photo.viewerUrl),
          })),
        });
        callback(photos);
      } catch (error) {
        logPhotoDbEvent('error', 'photo_subscription_snapshot_processing_failed', {
          visibility: 'private',
          tourId: summarizePrincipalForDbLog(tourId),
          ownerId: summarizePrincipalForDbLog(ownerScope),
          error: summarizeErrorForDbLog(error),
        });
        callback([]);
      }
    }, (error) => {
      logPhotoDbEvent('error', 'photo_subscription_failed', {
        visibility: 'private',
        tourId: summarizePrincipalForDbLog(tourId),
        ownerId: summarizePrincipalForDbLog(ownerScope),
        error: summarizeErrorForDbLog(error),
      });
      callback([]);
    });

    return () => {
      try {
        logPhotoDbEvent('debug', 'photo_subscription_stop', {
          visibility: 'private',
          tourId: summarizePrincipalForDbLog(tourId),
          ownerId: summarizePrincipalForDbLog(ownerScope),
        });
        unsubscribe();
      } catch (error) {
        logPhotoDbEvent('warn', 'photo_subscription_unsubscribe_failed', {
          visibility: 'private',
          tourId: summarizePrincipalForDbLog(tourId),
          ownerId: summarizePrincipalForDbLog(ownerScope),
          error: summarizeErrorForDbLog(error),
        });
      }
    };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_subscription_setup_failed', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      error: summarizeErrorForDbLog(error),
    });
    return () => {};
  }
};

/**
 * Delete a photo from a group album
 * Only the photo owner can delete their photos
 * @param {string} tourId - Tour ID
 * @param {string} photoId - Photo ID
 * @param {string} requestingUserId - UID of the user requesting the deletion (for ownership verification)
 * @param {Object} options - Optional dependency injection for testing
 */
const deleteGroupPhoto = async (
  tourId,
  photoId,
  requestingUserId,
  {
    storageInstance = storage,
    realtimeDbInstance = realtimeDbModular,
    storageRefFn = storageRef,
    deleteObjectFn = deleteObject,
    dbRefFn = databaseRef,
    removeFn = remove,
    getFn = get,
  } = {}
) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    const validatedPhotoId = validatePhotoId(photoId);

    if (!requestingUserId || typeof requestingUserId !== 'string') {
      throw new Error('User ID is required to delete a photo');
    }

    if (!storageInstance) {
      throw new Error('Storage instance not initialized');
    }

    if (!realtimeDbInstance) {
      throw new Error('Database instance not initialized');
    }

    logPhotoDbEvent('info', 'photo_delete_start', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(validatedTourId),
      photoId: summarizePrincipalForDbLog(validatedPhotoId),
      requestingUserId: summarizePrincipalForDbLog(requestingUserId),
    });

    // First, get the photo data to find the storage path
    const photoRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${validatedTourId}/${validatedPhotoId}`);
    const snapshot = await getFn(photoRef);
    const photoData = snapshot.val();

    if (!photoData) {
      logPhotoDbEvent('warn', 'photo_delete_missing_record', {
        visibility: 'group',
        tourId: summarizePrincipalForDbLog(validatedTourId),
        photoId: summarizePrincipalForDbLog(validatedPhotoId),
      });
      throw new Error('Photo not found');
    }

    logPhotoDbEvent('debug', 'photo_delete_record_loaded', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(validatedTourId),
      photoId: summarizePrincipalForDbLog(validatedPhotoId),
      ownerId: summarizePrincipalForDbLog(photoData.userId),
      hasSourcePath: Boolean(photoData.storagePath),
      hasViewerPath: Boolean(photoData.viewerStoragePath),
      hasThumbnailPath: Boolean(photoData.thumbnailStoragePath),
    });

    // Verify ownership: only the photo uploader can delete it
    if (photoData.userId && photoData.userId !== requestingUserId) {
      logPhotoDbEvent('warn', 'photo_delete_blocked_owner_mismatch', {
        visibility: 'group',
        tourId: summarizePrincipalForDbLog(validatedTourId),
        photoId: summarizePrincipalForDbLog(validatedPhotoId),
        ownerId: summarizePrincipalForDbLog(photoData.userId),
        requestingUserId: summarizePrincipalForDbLog(requestingUserId),
      });
      throw new Error('You can only delete your own photos');
    }

    await deleteStoredPhotoObject({
      storageInstance,
      storageRefFn,
      deleteObjectFn,
      path: photoData.storagePath,
      label: 'photo',
    });
    await deleteStoredPhotoObject({
      storageInstance,
      storageRefFn,
      deleteObjectFn,
      path: photoData.viewerStoragePath,
      label: 'viewer photo',
    });
    await deleteStoredPhotoObject({
      storageInstance,
      storageRefFn,
      deleteObjectFn,
      path: photoData.thumbnailStoragePath,
      label: 'thumbnail',
    });

    // Delete from database (with timeout)
    await Promise.race([
      removeFn(photoRef),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database deletion timeout')), 10000)
      )
    ]);

    logPhotoDbEvent('info', 'photo_delete_success', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(validatedTourId),
      photoId: summarizePrincipalForDbLog(validatedPhotoId),
    });
    return { success: true };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_delete_failed', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(tourId),
      photoId: summarizePrincipalForDbLog(photoId),
      requestingUserId: summarizePrincipalForDbLog(requestingUserId),
      error: summarizeErrorForDbLog(error),
    });
    throw error;
  }
};

/**
 * Delete a photo from a private album
 */
const deletePrivatePhoto = async (
  tourId,
  ownerId,
  photoId,
  {
    storageInstance = storage,
    realtimeDbInstance = realtimeDbModular,
    storageRefFn = storageRef,
    deleteObjectFn = deleteObject,
    dbRefFn = databaseRef,
    removeFn = remove,
    getFn = get,
  } = {}
) => {
  if (!tourId || !ownerId || !photoId) {
    throw new Error('Missing delete parameters');
  }

  try {
    const ownerScopeKey = sanitizeRealtimeKeySegment(ownerId);
    logPhotoDbEvent('info', 'photo_delete_start', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
      photoId: summarizePrincipalForDbLog(photoId),
    });

    // First, get the photo data to find the storage path
    const photoRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${tourId}/${ownerScopeKey}/${photoId}`);
    const snapshot = await getFn(photoRef);
    const photoData = snapshot.val();

    if (!photoData) {
      logPhotoDbEvent('warn', 'photo_delete_missing_record', {
        visibility: 'private',
        tourId: summarizePrincipalForDbLog(tourId),
        ownerId: summarizePrincipalForDbLog(ownerId),
        photoId: summarizePrincipalForDbLog(photoId),
      });
      throw new Error('Photo not found');
    }

    logPhotoDbEvent('debug', 'photo_delete_record_loaded', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
      photoId: summarizePrincipalForDbLog(photoId),
      hasSourcePath: Boolean(photoData.storagePath),
      hasViewerPath: Boolean(photoData.viewerStoragePath),
      hasThumbnailPath: Boolean(photoData.thumbnailStoragePath),
    });

    await deleteStoredPhotoObject({
      storageInstance,
      storageRefFn,
      deleteObjectFn,
      path: photoData.storagePath,
      label: 'private photo',
    });
    await deleteStoredPhotoObject({
      storageInstance,
      storageRefFn,
      deleteObjectFn,
      path: photoData.viewerStoragePath,
      label: 'private viewer photo',
    });
    await deleteStoredPhotoObject({
      storageInstance,
      storageRefFn,
      deleteObjectFn,
      path: photoData.thumbnailStoragePath,
      label: 'private thumbnail',
    });

    // Delete from database
    await removeFn(photoRef);

    logPhotoDbEvent('info', 'photo_delete_success', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
      photoId: summarizePrincipalForDbLog(photoId),
    });
    return { success: true };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_delete_failed', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      photoId: summarizePrincipalForDbLog(photoId),
      error: summarizeErrorForDbLog(error),
    });
    throw error;
  }
};

const updatePhotoCaption = async (
  { tourId, photoId, userId, ownerId, caption, visibility = 'group' },
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    updateFn = update,
    serverTimestampFn = serverTimestamp,
    nowFn = Date.now,
  } = {},
) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedPhotoId = validatePhotoId(photoId);
    const resolvedOwnerId = validateUserId(ownerId || userId);
    const resolvedOwnerKey = sanitizeRealtimeKeySegment(resolvedOwnerId);
    const validatedCaption = validateCaption(caption);
    const validatedVisibility = validateVisibility(visibility);

    const basePath = validatedVisibility === 'private'
      ? `private_tour_photos/${validatedTourId}/${resolvedOwnerKey}/${validatedPhotoId}`
      : `group_tour_photos/${validatedTourId}/${validatedPhotoId}`;

    logPhotoDbEvent('info', 'photo_caption_update_start', {
      visibility: validatedVisibility,
      tourId: summarizePrincipalForDbLog(validatedTourId),
      photoId: summarizePrincipalForDbLog(validatedPhotoId),
      ownerId: summarizePrincipalForDbLog(resolvedOwnerId),
      ownerKey: summarizePrincipalForDbLog(resolvedOwnerKey),
      captionLength: validatedCaption.length,
    });

    const photoRef = dbRefFn(realtimeDbInstance, basePath);
    await updateFn(photoRef, {
      caption: validatedCaption,
      captionUpdatedAt: resolveRealtimeTimestamp(serverTimestampFn, nowFn),
      captionEditedBy: resolvedOwnerId,
    });

    logPhotoDbEvent('info', 'photo_caption_update_success', {
      visibility: validatedVisibility,
      tourId: summarizePrincipalForDbLog(validatedTourId),
      photoId: summarizePrincipalForDbLog(validatedPhotoId),
      ownerId: summarizePrincipalForDbLog(resolvedOwnerId),
      captionLength: validatedCaption.length,
    });

    return { success: true };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_caption_update_failed', {
      visibility,
      tourId: summarizePrincipalForDbLog(tourId),
      photoId: summarizePrincipalForDbLog(photoId),
      ownerId: summarizePrincipalForDbLog(ownerId || userId),
      captionLength: typeof caption === 'string' ? caption.trim().length : 0,
      error: summarizeErrorForDbLog(error),
    });
    throw error;
  }
};


const uploadPhotoDirect = async (payload = {}) => {
  let directDiagnostics = {};

  try {
    const {
      uri,
      tourId,
      userId,
      ownerId,
      caption = '',
      visibility = 'group',
      uploaderName = 'Tour Member',
      optimizationMetrics = null,
      onProgress = null,
      localAssets = null,
      metadata = null,
      idempotencyKey = null,
    } = payload;

    const resolvedLocalAssets = localAssets && typeof localAssets === 'object' ? localAssets : {};
    const resolvedMetadata = metadata && typeof metadata === 'object' ? metadata : {};
    const sourceUri = uri || resolvedLocalAssets.sourceUri;
    const sourceCaption = (typeof caption === 'string' && caption.length > 0)
      ? caption
      : (resolvedMetadata.caption ?? '');
    const sourceOptimizationMetrics = optimizationMetrics || resolvedLocalAssets.optimizationMetrics || null;

    const resolvedOwnerId = ownerId || userId;
    directDiagnostics = {
      payloadVersion: 2,
      visibility,
      tourId: summarizePrincipalForDbLog(tourId),
      userId: summarizePrincipalForDbLog(userId),
      ownerId: summarizePrincipalForDbLog(resolvedOwnerId),
      ownerKey: summarizePrincipalForDbLog(
        typeof resolvedOwnerId === 'string' && resolvedOwnerId.trim()
          ? sanitizeRealtimeKeySegment(resolvedOwnerId)
          : null
      ),
      hasIdempotencyKey: Boolean(idempotencyKey),
      idempotencyKey: summarizePrincipalForDbLog(idempotencyKey),
      hasSourceUri: Boolean(sourceUri),
      sourceUri: summarizeUriForDbLog(sourceUri),
      hasLocalAssets: Boolean(localAssets),
      localAssetKeys: Object.keys(resolvedLocalAssets),
    };
    logPhotoDbEvent('info', 'photo_upload_direct_start', directDiagnostics);

    const validatedTourId = validateTourId(tourId);
    const validatedUserId = validateUserId(resolvedOwnerId);
    const validatedCaption = validateCaption(sourceCaption);
    const validatedVisibility = validateVisibility(visibility);
    const normalizedIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.trim()
      ? idempotencyKey.trim().slice(0, IDEMPOTENCY_KEY_MAX_LENGTH)
      : null;

    if (!normalizedIdempotencyKey) {
      logPhotoDbEvent('warn', 'photo_upload_direct_missing_idempotency_key', directDiagnostics);
      return { success: false, error: 'idempotencyKey is required for photo uploads' };
    }

    const data = await uploadPhoto(sourceUri, validatedTourId, validatedUserId, validatedCaption, {
      visibility: validatedVisibility,
      uploaderName,
      optimizationMetrics: sourceOptimizationMetrics,
      onProgress,
      idempotencyKey: normalizedIdempotencyKey,
    });

    return { success: true, data };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_upload_direct_failed', {
      diagnostics: directDiagnostics,
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error?.message || 'Photo upload failed' };
  }
};

module.exports = {
  uploadPhoto,
  uploadPhotoDirect,
  fetchTourPhotosPage,
  fetchPrivatePhotosPage,
  subscribeToTourPhotos,
  subscribeToPrivatePhotos,
  deleteGroupPhoto,
  deletePrivatePhoto,
  updatePhotoCaption,
  createBlob,
};
