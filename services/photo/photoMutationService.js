const { withHttpRequestBoundary } = require('../httpRequestBoundary');
const { withPhotoRequestBoundary } = require('./photoRequestBoundary');
const {
  GROUP_DELETE_FUNCTION_NAME,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  PRIVATE_DELETE_FUNCTION_NAME,
  auth,
  databaseRef,
  getCurrentAppCheckToken,
  logPhotoDbEvent,
  realtimeDbModular,
  resolveRealtimeTimestamp,
  serverTimestamp,
  summarizeErrorForDbLog,
  summarizePrincipalForDbLog,
  summarizeUriForDbLog,
  update,
} = require('./photoServiceContext');
const {
  buildGroupPhotoAuthHeaders,
  buildGroupPhotoEndpointUrl,
  buildPrivatePhotoEndpointUrl,
  sanitizeRealtimeKeySegment,
  validateCaption,
  validatePhotoId,
  validateTourId,
  validateUserId,
  validateVisibility,
} = require('./photoMediaService');
const { uploadPhoto } = require('./photoUploadService');

const deleteGroupPhotoWithinBoundary = async (
  tourId,
  photoId,
  requestingUserId,
  {
    authInstance = auth,
    fetchFn = fetch,
    endpoint = buildGroupPhotoEndpointUrl(GROUP_DELETE_FUNCTION_NAME, authInstance),
    appCheckTokenFn = getCurrentAppCheckToken,
    requestBoundary,
  } = {}
) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedPhotoId = validatePhotoId(photoId);
    if (!requestingUserId || typeof requestingUserId !== 'string') {
      throw new Error('User ID is required to delete a photo');
    }
    if (!endpoint) throw new Error('Group photo delete endpoint is unavailable');
    const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn, requestBoundary);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tourId: validatedTourId, photoId: validatedPhotoId }),
    });
    const payload = await response.json().catch(error => { if (error?.code?.startsWith('PHOTO_')) throw error; return null; });
    if (!response.ok || payload?.success !== true) {
      if (payload?.reason === 'NOT_OWNER') throw new Error('You can only delete your own photos');
      throw new Error('Photo could not be deleted');
    }
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
const deletePrivatePhotoWithinBoundary = async (
  tourId,
  ownerId,
  photoId,
  {
    authInstance = auth,
    fetchFn = fetch,
    endpoint = buildPrivatePhotoEndpointUrl(PRIVATE_DELETE_FUNCTION_NAME, authInstance),
    appCheckTokenFn = getCurrentAppCheckToken,
    requestBoundary,
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

    if (!endpoint) throw new Error('Private photo delete endpoint is unavailable');
    const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn, requestBoundary);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tourId, photoId }),
    });
    const payload = await response.json().catch(error => { if (error?.code?.startsWith('PHOTO_')) throw error; return null; });
    if (!response.ok || payload?.success !== true) {
      throw new Error(payload?.reason === 'NOT_AUTHORIZED'
        ? 'You no longer have access to this tour'
        : 'Private photo could not be deleted');
    }

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

const deleteGroupPhoto = (tourId, photoId, requestingUserId, options = {}) => withPhotoRequestBoundary({
  authInstance: options.authInstance || auth, fetchFn: options.fetchFn || fetch, timeoutMs: options.requestTimeoutMs ?? 15000,
}, boundary => deleteGroupPhotoWithinBoundary(tourId, photoId, requestingUserId, { ...options, fetchFn: boundary.fetch, requestBoundary: boundary }));
const deletePrivatePhoto = (tourId, ownerId, photoId, options = {}) => withPhotoRequestBoundary({
  authInstance: options.authInstance || auth, fetchFn: options.fetchFn || fetch, timeoutMs: options.requestTimeoutMs ?? 15000,
}, boundary => deletePrivatePhotoWithinBoundary(tourId, ownerId, photoId, { ...options, fetchFn: boundary.fetch, requestBoundary: boundary }));

const updatePhotoCaption = async (
  { tourId, photoId, userId, ownerId, caption, visibility = 'group' },
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    updateFn = update,
    serverTimestampFn = serverTimestamp,
    nowFn = Date.now,
    requestTimeoutMs = 15000,
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
    await withHttpRequestBoundary(async boundary => {
      await updateFn(photoRef, {
      caption: validatedCaption,
      captionUpdatedAt: resolveRealtimeTimestamp(serverTimestampFn, nowFn),
      captionEditedBy: resolvedOwnerId,
      });
      boundary.check();
    }, { timeoutMs: requestTimeoutMs });

    logPhotoDbEvent('info', 'photo_caption_update_success', {
      visibility: validatedVisibility,
      tourId: summarizePrincipalForDbLog(validatedTourId),
      photoId: summarizePrincipalForDbLog(validatedPhotoId),
      ownerId: summarizePrincipalForDbLog(resolvedOwnerId),
      captionLength: validatedCaption.length,
    });

    return { success: true };
  } catch (error) {
    if (error?.code === 'REQUEST_TIMEOUT') error.message = 'The caption update is unconfirmed and may still complete. Reopen the photo to check before retrying.';
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
  // Historical offline-queue API name: this delegates to uploadPhoto, which
  // always uses authenticated, active-session-protected media Functions.
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
  deleteGroupPhoto,
  deletePrivatePhoto,
  updatePhotoCaption,
  uploadPhotoDirect,
};
