const {
  GROUP_UPLOAD_FUNCTION_NAME,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  PRIVATE_UPLOAD_FUNCTION_NAME,
  auth,
  getCurrentAppCheckToken,
  logPhotoDbEvent,
  summarizeErrorForDbLog,
  summarizePrincipalForDbLog,
  summarizeUriForDbLog,
} = require('./photoServiceContext');
const {
  buildGroupPhotoAuthHeaders,
  buildGroupPhotoEndpointUrl,
  buildPrivatePhotoEndpointUrl,
  createBlob,
  sanitizeRealtimeKeySegment,
  validateBlob,
  validateCaption,
  validateTourId,
  validateUri,
  validateUserId,
  validateVisibility,
} = require('./photoMediaService');

const uploadPhoto = async (
  uri,
  tourId,
  userId,
  caption = '',
  {
    visibility = 'group',
    uploaderName = 'Tour Member',
    authInstance = auth,
    fetchFn = fetch,
    onProgress = null,
    optimizationMetrics: _optimizationMetrics = null,
    idempotencyKey = null,
    nowFn: _nowFn = Date.now,
    groupUploadEndpoint = buildGroupPhotoEndpointUrl(GROUP_UPLOAD_FUNCTION_NAME, authInstance),
    privateUploadEndpoint = buildPrivatePhotoEndpointUrl(PRIVATE_UPLOAD_FUNCTION_NAME, authInstance),
    appCheckTokenFn = getCurrentAppCheckToken,
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

    if (!isPrivate) {
      uploadStage = 'uploading_group_photo_via_server';
      try {
        if (!normalizedIdempotencyKey) throw new Error('idempotencyKey is required for group photo uploads');
        if (!groupUploadEndpoint) throw new Error('Group photo upload endpoint is unavailable');
        const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
        if (typeof onProgress === 'function') onProgress(0.05);
        const encodedMetadata = encodeURIComponent(JSON.stringify({
          tourId: validatedTourId,
          idempotencyKey: normalizedIdempotencyKey,
          caption: validatedCaption,
          uploaderName: uploaderName || 'Tour Member',
        }));
        const response = await fetchFn(groupUploadEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': blob.type,
            'x-group-photo-metadata': encodedMetadata,
            ...authHeaders,
          },
          body: blob,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.success !== true || !payload.photo?.id) {
          throw new Error(payload?.reason === 'NOT_AUTHORIZED'
            ? 'You no longer have access to this tour'
            : 'Group photo upload could not be authorized');
        }
        if (typeof onProgress === 'function') onProgress(1);
        return payload.photo;
      } finally {
        if (blob && typeof blob.close === 'function') {
          try { blob.close(); } catch (_error) { /* best-effort release */ }
        }
      }
    }

    uploadStage = 'uploading_private_photo_via_server';
    try {
      if (!normalizedIdempotencyKey) throw new Error('idempotencyKey is required for private photo uploads');
      if (!privateUploadEndpoint) throw new Error('Private photo upload endpoint is unavailable');
      const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
      if (typeof onProgress === 'function') onProgress(0.05);
      const encodedMetadata = encodeURIComponent(JSON.stringify({
        tourId: validatedTourId,
        idempotencyKey: normalizedIdempotencyKey,
        caption: validatedCaption,
      }));
      const response = await fetchFn(privateUploadEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type,
          'x-private-photo-metadata': encodedMetadata,
          ...authHeaders,
        },
        body: blob,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success !== true || !payload.photo?.id) {
        throw new Error(payload?.reason === 'NOT_AUTHORIZED'
          ? 'You no longer have access to this tour'
          : 'Private photo upload could not be authorized');
      }
      if (typeof onProgress === 'function') onProgress(1);
      return payload.photo;
    } finally {
      if (blob && typeof blob.close === 'function') {
        try { blob.close(); } catch (_error) { /* best-effort release */ }
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

module.exports = { uploadPhoto };
