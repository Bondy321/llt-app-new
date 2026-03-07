const safeFileSize = async (asset) => {
  if (typeof asset?.fileSize === 'number') return asset.fileSize;
  return null;
};

export const optimizeImageForUpload = async (asset) => {
  if (!asset?.uri) {
    throw new Error('Missing image asset URI');
  }

  const originalSizeBytes = await safeFileSize(asset);

  return {
    uploadUri: asset.uri,
    thumbnailUri: asset.uri,
    metrics: {
      originalSizeBytes,
      optimizedSizeBytes: originalSizeBytes,
      thumbnailSizeBytes: originalSizeBytes,
      optimizationRatio: 0,
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
