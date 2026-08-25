const {
  LIVE_PHOTOS_WINDOW,
  databaseRef,
  limitToLast,
  logPhotoDbEvent,
  mapSnapshotToPhotos,
  onValue,
  orderByChild,
  query,
  realtimeDbModular,
  sanitizePageLimit,
  sortPhotosDescending,
  summarizeErrorForDbLog,
  summarizePrincipalForDbLog,
} = require('./photoServiceContext');
const {
  resolveGroupPhotoMedia,
  resolvePrivatePhotoMedia,
  sanitizeRealtimeKeySegment,
  validateTourId,
} = require('./photoMediaService');

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
    resolveGroupPhotoMediaFn = resolveGroupPhotoMedia,
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
    let generation = 0;
    const unsubscribe = onValueFn(photosQuery, (snapshot) => {
      const currentGeneration = ++generation;
      try {
        let photos = mapSnapshotToPhotos(snapshot);
        sortPhotosDescending(photos);
        const safePhotos = photos.map((photo) => {
          const { sourceUrl: _sourceUrl, viewerUrl: _viewerUrl, thumbnailUrl: _thumbnailUrl, ...safePhoto } = photo;
          return safePhoto;
        });
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
        callback(safePhotos);
        Promise.resolve(resolveGroupPhotoMediaFn({ tourId: validatedTourId, photos: safePhotos }))
          .then((hydrated) => {
            if (currentGeneration === generation) callback(hydrated);
          })
          .catch((error) => {
            if (currentGeneration === generation) {
              logPhotoDbEvent('warn', 'photo_subscription_media_resolution_failed', {
                visibility: 'group',
                tourId: summarizePrincipalForDbLog(validatedTourId),
                error: summarizeErrorForDbLog(error),
              });
            }
          });
      } catch (error) {
        logPhotoDbEvent('error', 'photo_subscription_snapshot_processing_failed', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
          error: summarizeErrorForDbLog(error),
        });
        callback([]); // Provide empty array as fallback
      }
    }, (error) => {
      generation += 1;
      logPhotoDbEvent('error', 'photo_subscription_failed', {
        visibility: 'group',
        tourId: summarizePrincipalForDbLog(validatedTourId),
        error: summarizeErrorForDbLog(error),
      });
      callback([]); // Provide empty array on error
    });

    return () => {
      generation += 1;
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
    resolvePrivatePhotoMediaFn = resolvePrivatePhotoMedia,
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

    let generation = 0;
    const unsubscribe = onValueFn(photosQuery, async (snapshot) => {
      const currentGeneration = ++generation;
      try {
        let photos = mapSnapshotToPhotos(snapshot, { ownerScope });
        sortPhotosDescending(photos);
        photos = await resolvePrivatePhotoMediaFn({ tourId, ownerKey: ownerScopeKey, photos });
        if (currentGeneration !== generation) return;
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
      generation += 1;
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

module.exports = { subscribeToPrivatePhotos, subscribeToTourPhotos };
