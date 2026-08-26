const {
  ALLOWED_IMAGE_TYPES,
  GROUP_DELETE_FUNCTION_NAME,
  GROUP_MEDIA_FUNCTION_NAME,
  GROUP_UPLOAD_FUNCTION_NAME,
  MAX_CAPTION_LENGTH,
  MAX_FILE_SIZE,
  PRIVATE_DELETE_FUNCTION_NAME,
  PRIVATE_MEDIA_BATCH_LIMIT,
  PRIVATE_MEDIA_FUNCTION_NAME,
  PRIVATE_UPLOAD_FUNCTION_NAME,
  assertTextPassesModeration,
  auth,
  getCurrentAppCheckToken,
} = require('./photoServiceContext');
const { isResolvedMediaResponse } = require('../../src/shared/api/responseBoundaries');

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

  return assertTextPassesModeration(trimmed, 'Caption');
};

const buildPrivateMediaEndpointUrl = (authInstance = auth) => {
  const explicit = process.env.EXPO_PUBLIC_RESOLVE_PRIVATE_PHOTO_MEDIA_URL?.trim();
  if (explicit) return explicit;
  const projectId = authInstance?.app?.options?.projectId;
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${PRIVATE_MEDIA_FUNCTION_NAME}` : null;
};

const buildPrivatePhotoEndpointUrl = (functionName, authInstance = auth) => {
  const envNames = {
    [PRIVATE_UPLOAD_FUNCTION_NAME]: 'EXPO_PUBLIC_UPLOAD_PRIVATE_PHOTO_URL',
    [PRIVATE_DELETE_FUNCTION_NAME]: 'EXPO_PUBLIC_DELETE_PRIVATE_PHOTO_URL',
  };
  const explicit = process.env[envNames[functionName]]?.trim();
  if (explicit) return explicit;
  const projectId = authInstance?.app?.options?.projectId;
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${functionName}` : null;
};

const buildGroupPhotoEndpointUrl = (functionName, authInstance = auth) => {
  const envNames = {
    [GROUP_MEDIA_FUNCTION_NAME]: 'EXPO_PUBLIC_RESOLVE_GROUP_PHOTO_MEDIA_URL',
    [GROUP_UPLOAD_FUNCTION_NAME]: 'EXPO_PUBLIC_UPLOAD_GROUP_PHOTO_URL',
    [GROUP_DELETE_FUNCTION_NAME]: 'EXPO_PUBLIC_DELETE_GROUP_PHOTO_URL',
  };
  const explicit = process.env[envNames[functionName]]?.trim();
  if (explicit) return explicit;
  const projectId = authInstance?.app?.options?.projectId;
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${functionName}` : null;
};

const buildGroupPhotoAuthHeaders = async (authInstance = auth, appCheckTokenFn = getCurrentAppCheckToken) => {
  const token = await authInstance?.currentUser?.getIdToken?.();
  if (!token) throw new Error('Authenticated user required for group photos');
  const appCheckToken = await appCheckTokenFn?.();
  const headers = { Authorization: `Bearer ${token}` };
  if (appCheckToken) headers['x-firebase-appcheck'] = appCheckToken;
  return headers;
};

const resolveGroupPhotoMedia = async ({ tourId, photos }, {
  authInstance = auth,
  fetchFn = fetch,
  endpoint = buildGroupPhotoEndpointUrl(GROUP_MEDIA_FUNCTION_NAME, authInstance),
  appCheckTokenFn = getCurrentAppCheckToken,
} = {}) => {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const safePhotos = photos.map((photo) => {
    const { sourceUrl: _sourceUrl, viewerUrl: _viewerUrl, thumbnailUrl: _thumbnailUrl, ...safePhoto } = photo;
    return safePhoto;
  });
  if (!endpoint) return safePhotos;
  const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
  const resolvedMedia = {};
  for (let offset = 0; offset < safePhotos.length; offset += PRIVATE_MEDIA_BATCH_LIMIT) {
    const batch = safePhotos.slice(offset, offset + PRIVATE_MEDIA_BATCH_LIMIT);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tourId, photoIds: batch.map((photo) => photo.id) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !isResolvedMediaResponse(payload)
      || Number(payload.expiresAtMs) <= Date.now()) {
      throw new Error('Group photo access could not be authorized');
    }
    Object.assign(resolvedMedia, payload.media);
  }
  return safePhotos.map((photo) => ({ ...photo, ...(resolvedMedia[photo.id] || {}) }));
};

const resolvePrivatePhotoMedia = async ({ tourId, ownerKey, photos }, {
  authInstance = auth,
  fetchFn = fetch,
  endpoint = buildPrivateMediaEndpointUrl(authInstance),
  appCheckTokenFn = getCurrentAppCheckToken,
} = {}) => {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const safePhotos = photos.map((photo) => {
    const { sourceUrl: _sourceUrl, viewerUrl: _viewerUrl, thumbnailUrl: _thumbnailUrl, ...safePhoto } = photo;
    return safePhoto;
  });
  if (!endpoint) return safePhotos;
  const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
  const resolvedMedia = {};
  for (let offset = 0; offset < safePhotos.length; offset += PRIVATE_MEDIA_BATCH_LIMIT) {
    const batch = safePhotos.slice(offset, offset + PRIVATE_MEDIA_BATCH_LIMIT);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tourId, ownerKey, photoIds: batch.map((photo) => photo.id) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !isResolvedMediaResponse(payload)
      || Number(payload.expiresAtMs) <= Date.now()) {
      throw new Error('Private photo access could not be authorized');
    }
    Object.assign(resolvedMedia, payload.media);
  }
  return safePhotos.map((photo) => ({ ...photo, ...(resolvedMedia[photo.id] || {}) }));
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

module.exports = {
  buildGroupPhotoAuthHeaders,
  buildGroupPhotoEndpointUrl,
  buildPrivatePhotoEndpointUrl,
  createBlob,
  resolveGroupPhotoMedia,
  resolvePrivatePhotoMedia,
  sanitizeRealtimeKeySegment,
  validateBlob,
  validateCaption,
  validatePhotoId,
  validateTourId,
  validateUri,
  validateUserId,
  validateVisibility,
};
