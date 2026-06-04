import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

const OPTIMIZATION_PROFILES = {
  full: {
    // Preserve the original aspect ratio and resolution to avoid user-visible cropping/downsizing.
    maxLongEdge: null,
    compress: 0.68,
    minCompress: 0.38,
    compressStep: 0.1,
    targetMaxBytes: 1400000,
    maxIterations: 6,
    format: ImageManipulator.SaveFormat.JPEG,
  },
};

const clampQuality = (quality, minCompress) => {
  const value = Number.isFinite(quality) ? quality : 0.7;
  const min = Number.isFinite(minCompress) ? minCompress : 0;
  return Math.max(min, Math.min(1, Number(value.toFixed(2))));
};

const resolveProfile = (profile, overrides = {}) => ({
  ...profile,
  ...overrides,
  // Keep final outputs in JPEG regardless of overrides.
  format: ImageManipulator.SaveFormat.JPEG,
});

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

const manipulateImageAsync = async (uri, actions = [], saveOptions = {}) => {
  const { format = ImageManipulator.SaveFormat.JPEG, ...restSaveOptions } = saveOptions;
  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  let renderedImage = null;

  try {
    actions.forEach((action) => {
      if (action.resize) {
        context.resize(action.resize);
      } else if (action.rotate) {
        context.rotate(action.rotate);
      } else if (action.flip) {
        context.flip(action.flip);
      } else if (action.crop) {
        context.crop(action.crop);
      } else if (action.extent && typeof context.extent === 'function') {
        context.extent(action.extent);
      }
    });

    renderedImage = await context.renderAsync();
    return await renderedImage.saveAsync({
      format,
      ...restSaveOptions,
    });
  } finally {
    renderedImage?.release?.();
    context?.release?.();
  }
};

const optimizeVariant = async (uri, profile, dimensions = {}) => {
  const resizeAction = buildResizeAction(dimensions.width, dimensions.height, profile.maxLongEdge);
  const actions = resizeAction ? [resizeAction] : [];

  const maxIterations = Math.max(1, profile.maxIterations || 1);
  const minCompress = Number.isFinite(profile.minCompress) ? profile.minCompress : profile.compress;
  const compressStep = Number.isFinite(profile.compressStep) && profile.compressStep > 0
    ? profile.compressStep
    : 0.1;
  const targetMaxBytes = Number.isFinite(profile.targetMaxBytes) ? profile.targetMaxBytes : null;

  let currentQuality = clampQuality(profile.compress, minCompress);
  let finalResult = null;
  let sizeBytes = null;
  let optimizationPasses = 0;

  for (let pass = 1; pass <= maxIterations; pass += 1) {
    finalResult = await manipulateImageAsync(uri, actions, {
      compress: currentQuality,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: false,
    });

    sizeBytes = await safeFileSize(finalResult.uri);
    optimizationPasses = pass;

    const withinBudget = !targetMaxBytes || (typeof sizeBytes === 'number' && sizeBytes <= targetMaxBytes);
    if (withinBudget || pass >= maxIterations || currentQuality <= minCompress) {
      break;
    }

    currentQuality = clampQuality(currentQuality - compressStep, minCompress);
  }

  return {
    uri: finalResult.uri,
    width: finalResult.width,
    height: finalResult.height,
    sizeBytes,
    optimizationPasses,
    finalQualityUsed: currentQuality,
    resizeApplied: Boolean(resizeAction),
  };
};

export const optimizeSourcePhotoForUpload = async (asset, options = {}) => {
  if (!asset?.uri) {
    throw new Error('Missing image asset URI');
  }

  const originalSizeBytes = typeof asset.fileSize === 'number' ? asset.fileSize : await safeFileSize(asset.uri);
  const dimensions = { width: asset.width, height: asset.height };

  const fullProfile = resolveProfile(OPTIMIZATION_PROFILES.full, {
    targetMaxBytes: options.fullTargetMaxBytes ?? OPTIMIZATION_PROFILES.full.targetMaxBytes,
    maxIterations: options.maxIterations ?? OPTIMIZATION_PROFILES.full.maxIterations,
  });

  const full = await optimizeVariant(asset.uri, fullProfile, dimensions);

  return {
    uploadUri: full.uri,
    metrics: {
      originalSizeBytes,
      optimizedSizeBytes: full.sizeBytes,
      optimizationRatio: originalSizeBytes && full.sizeBytes
        ? Number((1 - (full.sizeBytes / originalSizeBytes)).toFixed(4))
        : null,
      fullOptimizationPasses: full.optimizationPasses,
      fullFinalQualityUsed: full.finalQualityUsed,
      fullResizeApplied: full.resizeApplied,
      viewerSizeBytes: null,
      thumbnailSizeBytes: null,
      viewerOptimizationRatio: null,
      viewerOptimizationPasses: 0,
      thumbnailOptimizationPasses: 0,
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
