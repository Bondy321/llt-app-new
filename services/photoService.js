// services/photoService.js
// Production-ready photo service using Firebase Storage and Realtime Database

const { ref: storageRef, uploadBytes, getDownloadURL } = require('firebase/storage');
const { firebase, storage, realtimeDb } = require('../firebase');

const createBlob = async (uri, fetchFn = fetch) => {
  if (!uri) {
    const error = new Error('No file URI provided');
    error.code = 'invalid-params';
    throw error;
  }

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
    storageInstance = storage,
    realtimeDbInstance = realtimeDb,
    storageRefFn = storageRef,
    uploadBytesFn = uploadBytes,
    getDownloadURLFn = getDownloadURL,
    dbRefFn = (db, path) => db.ref(path),
    pushFn = (ref) => ref.push(),
    setFn = (ref, data) => ref.set(data),
    serverTimestampFn = () => firebase.database.ServerValue.TIMESTAMP,
    fetchFn = fetch,
    logFn = console.error,
  } = {}
) => {
  if (!uri || !tourId || !userId) {
    const error = new Error('Missing upload parameters');
    error.code = 'invalid-params';
    throw error;
  }

  const filename = `${Date.now()}_${userId}.jpg`;
  const filePath = `tours/${tourId}/${filename}`;
  const fileRef = storageRefFn(storageInstance, filePath);

  const blob = await createBlob(uri, fetchFn);

  try {
    await uploadBytesFn(fileRef, blob);
    const downloadURL = await getDownloadURLFn(fileRef);

    const photosRef = dbRefFn(realtimeDbInstance, `photos/${tourId}`);
    const newPhotoRef = pushFn(photosRef);
    await setFn(newPhotoRef, {
      url: downloadURL,
      userId,
      caption: caption || '',
      timestamp: serverTimestampFn(),
    });

    return {
      id: newPhotoRef.key,
      url: downloadURL,
      userId,
      caption: caption || '',
    };
  } catch (error) {
    logFn('Photo upload failed', { message: error?.message, code: error?.code });
    throw error;
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
    realtimeDbInstance = realtimeDb,
    dbRefFn = (db, path) => db.ref(path),
    onValueFn = (ref, handler) => ref.on('value', handler),
    offFn = (ref, handler) => {
      if (ref && typeof ref.off === 'function') {
        ref.off('value', handler);
      }
    },
  } = {}
) => {
  if (!tourId || typeof callback !== 'function' || !realtimeDbInstance) {
    return () => {};
  }

  const photosRef = dbRefFn(realtimeDbInstance, `photos/${tourId}`);
  const handleSnapshot = (snapshot) => {
    const data = snapshot.val() || {};
    const photos = Object.entries(data).map(([key, value]) => ({
      id: key,
      ...value,
    }));

    photos.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    callback(photos);
  };

  onValueFn(photosRef, handleSnapshot);

  return () => offFn(photosRef, handleSnapshot);
};

module.exports = {
  uploadPhoto,
  subscribeToTourPhotos,
  createBlob,
};
