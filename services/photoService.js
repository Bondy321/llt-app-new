// services/photoService.js
// Production-ready photo service using Firebase Storage and Realtime Database

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

const createBlob = async (uri, fetchFn = fetch) => {
  const response = await fetchFn(uri);
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
  if (!uri || !tourId || !userId) {
    throw new Error('Missing upload parameters');
  }

  const isPrivate = visibility === 'private';
  const filename = `${Date.now()}_${userId}.jpg`;
  const storagePath = isPrivate
    ? `private_tour_photos/${tourId}/${userId}/${filename}`
    : `group_tour_photos/${tourId}/${filename}`;
  const fileRef = storageRefFn(storageInstance, storagePath);

  const blob = await createBlob(uri, fetchFn);

  try {
    await uploadBytesFn(fileRef, blob);
    const downloadURL = await getDownloadURLFn(fileRef);

    const databasePath = isPrivate
      ? `private_tour_photos/${tourId}/${userId}`
      : `group_tour_photos/${tourId}`;
    const photosRef = dbRefFn(realtimeDbInstance, databasePath);
    const newPhotoRef = pushFn(photosRef);

    const photoData = {
      url: downloadURL,
      userId,
      caption: caption || '',
      timestamp: serverTimestampFn(),
      storagePath,
    };

    // Add uploader name for group photos
    if (!isPrivate && uploaderName) {
      photoData.uploaderName = uploaderName;
    }

    await setFn(newPhotoRef, photoData);

    return {
      id: newPhotoRef.key,
      url: downloadURL,
      userId,
      caption: caption || '',
      uploaderName: uploaderName || 'Tour Member',
    };
  } finally {
    if (blob && typeof blob.close === 'function') {
      blob.close();
    }
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
  if (!tourId || typeof callback !== 'function') {
    return () => {};
  }

  const photosRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${tourId}`);

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
  if (!tourId || !photoId) {
    throw new Error('Missing delete parameters');
  }

  try {
    // First, get the photo data to find the storage path
    const photoRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${tourId}/${photoId}`);
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
