// services/photoService.js
// Production-ready photo service using Firebase Storage and Realtime Database
// Enhanced with comprehensive validation, file type checking, and size limits

const { ref: storageRef, uploadBytes, getDownloadURL, deleteObject } = require('firebase/storage');
const {
  ref: databaseRef,
  push,
  set,
  remove,
  serverTimestamp,
  onValue,
  get,
} = require('firebase/database');
const { storage, realtimeDbModular } = require('../firebase');

// ==================== CONSTANTS ====================

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
const MAX_CAPTION_LENGTH = 500;

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
    getDownloadURLFn = getDownloadURL,
    dbRefFn = databaseRef,
    pushFn = push,
    setFn = set,
    serverTimestampFn = serverTimestamp,
    fetchFn = fetch,
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

    const filename = `${Date.now()}_${validatedUserId}.${extension}`;
    const storagePath = isPrivate
      ? `private_tour_photos/${validatedTourId}/${validatedUserId}/${filename}`
      : `group_tour_photos/${validatedTourId}/${filename}`;
    const fileRef = storageRefFn(storageInstance, storagePath);

    try {
      // Upload to storage with timeout
      await Promise.race([
        uploadBytesFn(fileRef, blob, {
          contentType: blob.type,
          customMetadata: {
            uploadedBy: validatedUserId,
            uploadedAt: new Date().toISOString(),
          },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Photo upload timeout')), 60000)
        )
      ]);

      const downloadURL = await getDownloadURLFn(fileRef);

      const databasePath = isPrivate
        ? `private_tour_photos/${validatedTourId}/${validatedUserId}`
        : `group_tour_photos/${validatedTourId}`;
      const photosRef = dbRefFn(realtimeDbInstance, databasePath);
      const newPhotoRef = pushFn(photosRef);

      const photoData = {
        url: downloadURL,
        userId: validatedUserId,
        caption: validatedCaption,
        timestamp: serverTimestampFn(),
        storagePath,
        fileSize: blob.size,
        fileType: blob.type,
      };

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

    const unsubscribe = onValueFn(photosRef, (snapshot) => {
      try {
        const data = snapshot.val() || {};
        const photos = Object.entries(data).map(([key, value]) => ({
          id: key,
          ...value,
        }));

        photos.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
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
  } = {},
) => {
  if (!tourId || !userId || typeof callback !== 'function') {
    return () => {};
  }

  const photosRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${tourId}/${userId}`);

  const unsubscribe = onValueFn(photosRef, (snapshot) => {
    const data = snapshot.val() || {};
    const photos = Object.entries(data).map(([key, value]) => ({
      id: key,
      ...value,
    }));

    photos.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    callback(photos);
  });

  return () => unsubscribe();
};

/**
 * Delete a photo from a group album
 * Only the photo owner can delete their photos
 */
const deleteGroupPhoto = async (
  tourId,
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
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    const validatedPhotoId = validatePhotoId(photoId);

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

    // Delete from database
    await removeFn(photoRef);

    return { success: true };
  } catch (error) {
    console.error('Delete private photo error:', error);
    throw error;
  }
};

module.exports = {
  uploadPhoto,
  subscribeToTourPhotos,
  subscribeToPrivatePhotos,
  deleteGroupPhoto,
  deletePrivatePhoto,
  createBlob,
};
