import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';

const OPTIMIZATION_PROFILES = {
  full: {
    maxLongEdge: 1600,
    compress: 0.68,
    format: ImageManipulator.SaveFormat.JPEG,
  },
  thumbnail: {
    maxLongEdge: 420,
    compress: 0.55,
    format: ImageManipulator.SaveFormat.JPEG,
  },
};

const safeFileSize = async (uri) => {
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    return typeof info?.size === 'number' ? info.size : null;
  } catch {
    return null;
  }
};

const buildResizeAction = (width, height, maxLongEdge) => {
  if (!width || !height || !maxLongEdge) return null;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return null;

  if (width >= height) {
    return { resize: { width: maxLongEdge } };
  }

  return { resize: { height: maxLongEdge } };
};

const optimizeVariant = async (uri, profile, dimensions = {}) => {
  const resizeAction = buildResizeAction(dimensions.width, dimensions.height, profile.maxLongEdge);
  const actions = resizeAction ? [resizeAction] : [];

  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: profile.compress,
    format: profile.format,
    base64: false,
  });

  const sizeBytes = await safeFileSize(result.uri);
  return {
    uri: result.uri,
    width: result.width,
    height: result.height,
    sizeBytes,
  };
};

export const optimizeImageForUpload = async (asset) => {
  if (!asset?.uri) {
    throw new Error('Missing image asset URI');
  }

  const originalSizeBytes = typeof asset.fileSize === 'number' ? asset.fileSize : await safeFileSize(asset.uri);
  const dimensions = { width: asset.width, height: asset.height };

  const full = await optimizeVariant(asset.uri, OPTIMIZATION_PROFILES.full, dimensions);
  const thumbnail = await optimizeVariant(full.uri, OPTIMIZATION_PROFILES.thumbnail, {
    width: full.width,
    height: full.height,
  });

  return {
    uploadUri: full.uri,
    thumbnailUri: thumbnail.uri,
    metrics: {
      originalSizeBytes,
      optimizedSizeBytes: full.sizeBytes,
      thumbnailSizeBytes: thumbnail.sizeBytes,
      optimizationRatio: originalSizeBytes && full.sizeBytes
        ? Number((1 - (full.sizeBytes / originalSizeBytes)).toFixed(4))
        : null,
    },
  };
};

export const formatBytes = (bytes) => {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
};
