// services/photoService.js
const {
  ref: storageRef,
  uploadBytesResumable,
  getDownloadURL,
  listAll
} = require('firebase/storage');
const { storage } = require('../firebase');

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB limit

const mapStorageErrorCode = (error) => {
  if (error?.code === 'storage/unauthorized' || error?.code === 'storage/canceled') {
    return 'permission-denied';
  }

  if (error?.code === 'storage/retry-limit-exceeded' || error?.message?.includes('network')) {
    return 'network-error';
  }

  return error?.code || 'unknown-error';
};

const loadTourPhotos = async (
  tourId,
  {
    storageInstance = storage,
    storageRefFn = storageRef,
    listAllFn = listAll,
    getDownloadURLFn = getDownloadURL
  } = {}
) => {
  try {
    const tourPhotosRef = storageRefFn(storageInstance, `group_tour_photos/${tourId}`);
    const result = await listAllFn(tourPhotosRef);

    const photoPromises = result.items.map(async (itemRef) => {
      const url = await getDownloadURLFn(itemRef);
      return {
        id: itemRef.name,
        url,
        name: itemRef.name
      };
    });

    return Promise.all(photoPromises);
  } catch (error) {
    console.error('Error loading photos:', error);
    throw error;
  }
};

const uploadImage = async (
  {
    imageUri,
    userId,
    tourId,
    onProgress,
    storageInstance = storage,
    storageRefFn = storageRef,
    uploadBytesResumableFn = uploadBytesResumable,
    getDownloadURLFn = getDownloadURL,
    maxFileSizeBytes = MAX_FILE_SIZE_BYTES
  }
) => {
  if (!imageUri || !userId || !tourId) {
    const missingError = new Error('Missing upload information');
    missingError.code = 'invalid-params';
    throw missingError;
  }

  try {
    const response = await fetch(imageUri);
    const blob = await response.blob();

    if (blob.size > maxFileSizeBytes) {
      const sizeError = new Error('File size exceeds limit');
      sizeError.code = 'file-too-large';
      throw sizeError;
    }

    const fileName = `photo_${Date.now()}_${userId}.jpg`;
    const filePath = `group_tour_photos/${tourId}/${fileName}`;
    const fileRef = storageRefFn(storageInstance, filePath);

    const uploadTask = uploadBytesResumableFn(fileRef, blob);

    const uploadResult = await new Promise((resolve, reject) => {
      uploadTask.on(
        'state_changed',
        (snapshot) => {
          if (onProgress && snapshot.totalBytes > 0) {
            const progress = snapshot.bytesTransferred / snapshot.totalBytes;
            onProgress(progress);
          }
        },
        (error) => {
          const mappedCode = mapStorageErrorCode(error);
          const wrappedError = new Error(error?.message || 'Upload failed');
          wrappedError.code = mappedCode;
          reject(wrappedError);
        },
        async () => {
          try {
            const downloadURL = await getDownloadURLFn(uploadTask.snapshot.ref);
            resolve({ downloadURL, fileName });
          } catch (err) {
            reject(err);
          }
        }
      );
    });

    return {
      id: uploadResult.fileName,
      url: uploadResult.downloadURL,
      name: uploadResult.fileName
    };
  } catch (error) {
    const mappedCode = mapStorageErrorCode(error);
    const wrappedError = new Error(error?.message || 'Upload failed');
    wrappedError.code = mappedCode;
    throw wrappedError;
  }
};

module.exports = {
  loadTourPhotos,
  uploadImage,
  MAX_FILE_SIZE_BYTES
};
