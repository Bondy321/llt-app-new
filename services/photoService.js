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
const { storage, realtimeDbModular } = require('../firebase');

// ==================== CONSTANTS ====================

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
const MAX_CAPTION_LENGTH = 500;
const LIVE_PHOTOS_WINDOW = 100;
const DOWNLOAD_URL_RETRYABLE_CODES = new Set([
  'storage/object-not-found',
  'storage/retry-limit-exceeded',
  'storage/unknown',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const mapSnapshotToPhotos = (snapshot) => {
  const data = snapshot.val() || {};
  return Object.entries(data).map(([id, value]) => ({
    id,
    ...value,
    timestamp: normalizeTimestamp(value?.timestamp),
  }));
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

  const snapshot = await getFn(queryFn(baseRef, ...constraints));
  const photos = mapSnapshotToPhotos(snapshot).filter((photo) => {
    if (!cursor) {
      return true;
    }
    return !(photo.timestamp === cursor.timestamp && (!cursor.id || photo.id === cursor.id));
  });

  return buildPagedPhotoResult(photos, safeLimit);
};

/**
 * Fetches a bounded page of private photos for a user ordered by timestamp descending.
 *
 * Input contract:
 * - tourId: required non-empty string
 * - userId: required non-empty string
 * - limit: optional positive integer (default 30, max 100)
 * - endBefore: optional cursor ({ timestamp, id }) or timestamp value
 *
 * Output contract:
 * - { items, nextCursor, hasMore }
 * - empty datasets return { items: [], nextCursor: null, hasMore: false }
 * - missing/invalid timestamps are normalized to 0 for deterministic ordering
 *
 * @param {{ tourId: string, userId: string, limit?: number, endBefore?: ({ timestamp: unknown, id?: string }|number|string|null) }} params
 * @param {Object} [deps]
 * @returns {Promise<{ items: Array<Object>, nextCursor: ({ timestamp: number, id: string }|null), hasMore: boolean }>}
 */
const fetchPrivatePhotosPage = async (
  { tourId, userId, limit = 30, endBefore = null },
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
  const validatedUserId = validateUserId(userId);
  const safeLimit = sanitizePageLimit(limit);
  const cursor = normalizeCursor(endBefore);

  const baseRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${validatedTourId}/${validatedUserId}`);
  const constraints = [orderByChildFn('timestamp')];
  if (cursor) {
    constraints.push(endAtFn(cursor.timestamp, cursor.id || undefined));
  }
  constraints.push(limitToLastFn(safeLimit + 1));

  const snapshot = await getFn(queryFn(baseRef, ...constraints));
  const photos = mapSnapshotToPhotos(snapshot).filter((photo) => {
    if (!cursor) {
      return true;
    }
    return !(photo.timestamp === cursor.timestamp && (!cursor.id || photo.id === cursor.id));
  });

  return buildPagedPhotoResult(photos, safeLimit);
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
    realtimeDbInstance = realtimeDbModular,
    storageRefFn = storageRef,
    uploadBytesFn = uploadBytes,
    uploadBytesResumableFn = uploadBytesResumable,
    getDownloadURLFn = getDownloadURL,
    dbRefFn = databaseRef,
    pushFn = push,
    setFn = set,
    serverTimestampFn = serverTimestamp,
    fetchFn = fetch,
    onProgress = null,
    thumbnailUri = null,
    optimizationMetrics = null,
  } = {}
) => {
  try {
    // Validate inputs
    const validatedUri = validateUri(uri);
    const validatedTourId = validateTourId(tourId);
    const validatedUserId = validateUserId(userId);
    const validatedCaption = validateCaption(caption);
    const validatedVisibility = validateVisibility(visibility);

    if (!storageInstance) {
      throw new Error('Storage instance not initialized');
    }

    if (!realtimeDbInstance) {
      throw new Error('Database instance not initialized');
    }

    const isPrivate = validatedVisibility === 'private';

    // Create blob and validate
    const blob = await createBlob(validatedUri, fetchFn);
    validateBlob(blob);

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
    const filename = `${uploadTimestamp}_${validatedUserId}.${extension}`;
    const storagePath = isPrivate
      ? `private_tour_photos/${validatedTourId}/${validatedUserId}/${filename}`
      : `group_tour_photos/${validatedTourId}/${filename}`;
    const fileRef = storageRefFn(storageInstance, storagePath);

    let thumbnailBlob = null;
    let thumbnailPath = null;
    let thumbnailDownloadURL = null;

    try {
      const metadata = {
        contentType: blob.type,
        customMetadata: {
          uploadedBy: validatedUserId,
          uploadedAt: new Date().toISOString(),
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

      await Promise.race([
        uploadWithProgress(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Photo upload timeout')), 60000)
        ),
      ]);

      const downloadURL = await getDownloadUrlWithRetry(getDownloadURLFn, fileRef);

      if (thumbnailUri && typeof thumbnailUri === 'string') {
        try {
          thumbnailBlob = await createBlob(thumbnailUri, fetchFn);
          validateBlob(thumbnailBlob);

          const thumbnailFilename = `${uploadTimestamp}_${validatedUserId}_thumb.jpg`;
          thumbnailPath = isPrivate
            ? `private_tour_photos/${validatedTourId}/${validatedUserId}/thumbnails/${thumbnailFilename}`
            : `group_tour_photos/${validatedTourId}/thumbnails/${thumbnailFilename}`;

          const thumbnailRef = storageRefFn(storageInstance, thumbnailPath);
          await uploadBytesFn(thumbnailRef, thumbnailBlob, {
            contentType: 'image/jpeg',
            customMetadata: {
              uploadedBy: validatedUserId,
              uploadedAt: new Date().toISOString(),
              variant: 'thumbnail',
            },
          });
          thumbnailDownloadURL = await getDownloadUrlWithRetry(getDownloadURLFn, thumbnailRef);
        } catch (thumbnailError) {
          thumbnailPath = null;
          thumbnailDownloadURL = null;
          console.warn('Thumbnail upload failed; continuing with full-size photo only.', thumbnailError);
        }
      }

      const databasePath = isPrivate
        ? `private_tour_photos/${validatedTourId}/${validatedUserId}`
        : `group_tour_photos/${validatedTourId}`;
      const photosRef = dbRefFn(realtimeDbInstance, databasePath);
      const newPhotoRef = pushFn(photosRef);

      const photoData = {
        url: downloadURL,
        fullUrl: downloadURL,
        userId: validatedUserId,
        caption: validatedCaption,
        timestamp: serverTimestampFn(),
        storagePath,
        fileSize: blob.size,
        fileType: blob.type,
      };

      if (thumbnailDownloadURL) {
        photoData.thumbnailUrl = thumbnailDownloadURL;
        photoData.thumbnailStoragePath = thumbnailPath;
      }

      if (optimizationMetrics && typeof optimizationMetrics === 'object') {
        photoData.optimization = {
          originalSizeBytes: optimizationMetrics.originalSizeBytes || null,
          optimizedSizeBytes: optimizationMetrics.optimizedSizeBytes || blob.size,
          thumbnailSizeBytes: optimizationMetrics.thumbnailSizeBytes || (thumbnailBlob ? thumbnailBlob.size : null),
          optimizationRatio: optimizationMetrics.optimizationRatio ?? null,
        };
      }

      // Add uploader name for group photos
      if (!isPrivate && uploaderName) {
        photoData.uploaderName = uploaderName.trim();
      }

      await setFn(newPhotoRef, photoData);

      return {
        id: newPhotoRef.key,
        url: downloadURL,
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
          console.warn('Error closing blob:', error);
        }
      }

      if (thumbnailBlob && typeof thumbnailBlob.close === 'function') {
        try {
          thumbnailBlob.close();
        } catch (error) {
          console.warn('Error closing thumbnail blob:', error);
        }
      }
    }
  } catch (error) {
    console.error('Error uploading photo:', error);
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
  } = {}
) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);

    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }

    if (!realtimeDbInstance) {
      console.warn('Database instance not available');
      return () => {};
    }

    const photosRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${validatedTourId}`);
    const photosQuery = queryFn(photosRef, orderByChildFn('timestamp'), limitToLastFn(LIVE_PHOTOS_WINDOW));

    const unsubscribe = onValueFn(photosQuery, (snapshot) => {
      try {
        const photos = mapSnapshotToPhotos(snapshot);
        sortPhotosDescending(photos);
        callback(photos);
      } catch (error) {
        console.error('Error processing photos snapshot:', error);
        callback([]); // Provide empty array as fallback
      }
    }, (error) => {
      console.error('Error in photos subscription:', error);
      callback([]); // Provide empty array on error
    });

    return () => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn('Error unsubscribing from photos:', error);
      }
    };
  } catch (error) {
    console.error('Error setting up photos subscription:', error);
    return () => {};
  }
};

const subscribeToPrivatePhotos = (
  tourId,
  userId,
  callback,
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    onValueFn = onValue,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
  } = {},
) => {
  if (!tourId || !userId || typeof callback !== 'function') {
    return () => {};
  }

  const photosRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${tourId}/${userId}`);
  const photosQuery = queryFn(photosRef, orderByChildFn('timestamp'), limitToLastFn(LIVE_PHOTOS_WINDOW));

  const unsubscribe = onValueFn(photosQuery, (snapshot) => {
    const photos = mapSnapshotToPhotos(snapshot);
    sortPhotosDescending(photos);
    callback(photos);
  });

  return () => unsubscribe();
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

    // First, get the photo data to find the storage path
    const photoRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${validatedTourId}/${validatedPhotoId}`);
    const snapshot = await getFn(photoRef);
    const photoData = snapshot.val();

    if (!photoData) {
      throw new Error('Photo not found');
    }

    // Verify ownership: only the photo uploader can delete it
    if (photoData.userId && photoData.userId !== requestingUserId) {
      throw new Error('You can only delete your own photos');
    }

    // Delete from storage if path exists (with timeout)
    if (photoData.storagePath) {
      try {
        const fileRef = storageRefFn(storageInstance, photoData.storagePath);
        await Promise.race([
          deleteObjectFn(fileRef),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Storage deletion timeout')), 10000)
          )
        ]);
      } catch (storageError) {
        // Log but don't fail if storage deletion fails
        console.warn('Could not delete photo from storage:', storageError);
      }
    }

    if (photoData.thumbnailStoragePath) {
      try {
        const thumbnailRef = storageRefFn(storageInstance, photoData.thumbnailStoragePath);
        await Promise.race([
          deleteObjectFn(thumbnailRef),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Thumbnail deletion timeout')), 10000)
          )
        ]);
      } catch (thumbnailError) {
        console.warn('Could not delete thumbnail from storage:', thumbnailError);
      }
    }

    // Delete from database (with timeout)
    await Promise.race([
      removeFn(photoRef),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database deletion timeout')), 10000)
      )
    ]);

    return { success: true };
  } catch (error) {
    console.error('Delete group photo error:', error);
    throw error;
  }
};

/**
 * Delete a photo from a private album
 */
const deletePrivatePhoto = async (
  tourId,
  userId,
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
  if (!tourId || !userId || !photoId) {
    throw new Error('Missing delete parameters');
  }

  try {
    // First, get the photo data to find the storage path
    const photoRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${tourId}/${userId}/${photoId}`);
    const snapshot = await getFn(photoRef);
    const photoData = snapshot.val();

    if (!photoData) {
      throw new Error('Photo not found');
    }

    // Delete from storage if path exists
    if (photoData.storagePath) {
      try {
        const fileRef = storageRefFn(storageInstance, photoData.storagePath);
        await deleteObjectFn(fileRef);
      } catch (storageError) {
        // Log but don't fail if storage deletion fails
        console.warn('Could not delete photo from storage:', storageError);
      }
    }

    if (photoData.thumbnailStoragePath) {
      try {
        const thumbnailRef = storageRefFn(storageInstance, photoData.thumbnailStoragePath);
        await deleteObjectFn(thumbnailRef);
      } catch (thumbnailError) {
        console.warn('Could not delete thumbnail from storage:', thumbnailError);
      }
    }

    // Delete from database
    await removeFn(photoRef);

    return { success: true };
  } catch (error) {
    console.error('Delete private photo error:', error);
    throw error;
  }
};

const updatePhotoCaption = async (
  { tourId, photoId, userId, caption, visibility = 'group' },
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    updateFn = update,
    serverTimestampFn = serverTimestamp,
  } = {},
) => {
  const validatedTourId = validateTourId(tourId);
  const validatedPhotoId = validatePhotoId(photoId);
  const validatedUserId = validateUserId(userId);
  const validatedCaption = validateCaption(caption);
  const validatedVisibility = validateVisibility(visibility);

  const basePath = validatedVisibility === 'private'
    ? `private_tour_photos/${validatedTourId}/${validatedUserId}/${validatedPhotoId}`
    : `group_tour_photos/${validatedTourId}/${validatedPhotoId}`;

  const photoRef = dbRefFn(realtimeDbInstance, basePath);
  await updateFn(photoRef, {
    caption: validatedCaption,
    captionUpdatedAt: serverTimestampFn(),
    captionEditedBy: validatedUserId,
  });

  return { success: true };
};


const uploadPhotoDirect = async (payload = {}) => {
  try {
    const {
      uri,
      tourId,
      userId,
      caption = '',
      visibility = 'group',
      uploaderName = 'Tour Member',
      thumbnailUri = null,
      optimizationMetrics = null,
      onProgress = null,
    } = payload;

    const data = await uploadPhoto(uri, tourId, userId, caption, {
      visibility,
      uploaderName,
      thumbnailUri,
      optimizationMetrics,
      onProgress,
    });

    return { success: true, data };
  } catch (error) {
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
