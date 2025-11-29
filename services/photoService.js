// services/photoService.js
// Production-ready photo service using Firebase Storage and Realtime Database

const { ref: storageRef, uploadBytes, getDownloadURL } = require('firebase/storage');
const {
  ref: databaseRef,
  push,
  set,
  serverTimestamp,
  onValue,
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
  const filePath = isPrivate
    ? `privatePhotos/${tourId}/${userId}/${filename}`
    : `tours/${tourId}/${filename}`;
  const fileRef = storageRefFn(storageInstance, filePath);

  const blob = await createBlob(uri, fetchFn);

  try {
    await uploadBytesFn(fileRef, blob);
    const downloadURL = await getDownloadURLFn(fileRef);

    const databasePath = isPrivate
      ? `privatePhotos/${tourId}/${userId}`
      : `photos/${tourId}`;
    const photosRef = dbRefFn(realtimeDbInstance, databasePath);
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

  const photosRef = dbRefFn(realtimeDbInstance, `photos/${tourId}`);

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

  const photosRef = dbRefFn(realtimeDbInstance, `privatePhotos/${tourId}/${userId}`);

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

module.exports = {
  uploadPhoto,
  subscribeToTourPhotos,
  subscribeToPrivatePhotos,
  createBlob,
};
