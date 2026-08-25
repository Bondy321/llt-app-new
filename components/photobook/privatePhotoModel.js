import * as FileSystem from 'expo-file-system/legacy';
import { parseTimestampMs } from '../../services/timeUtils';
import { summarizeQueueAction } from '../../services/crashDiagnosticsService';

export const formatPhotoDate = (timestamp, options) => {
  const parsedMs = parseTimestampMs(timestamp);
  return Number.isFinite(parsedMs)
    ? new Date(parsedMs).toLocaleDateString(undefined, options)
    : null;
};
export const getPhotoTimestampMs = (photo) => {
  const parsedMs = parseTimestampMs(photo?.timestamp);
  return Number.isFinite(parsedMs) ? parsedMs : 0;
};

export const resolveQueuedUploadSourceUri = (item) => {
  const sourceUri = item?.payload?.localAssets?.sourceUri || item?.payload?.uri;
  return isLoadablePhotoUri(sourceUri) ? sourceUri : null;
};

export const resolveQueuedUploadPreviewUri = (item) => {
  const localAssets = item?.payload?.localAssets || {};
  const previewUri = localAssets.previewUri
    || resolveQueuedUploadSourceUri(item);
  return isLoadablePhotoUri(previewUri) ? previewUri : null;
};

export const verifyQueuedUploadSource = async (item) => {
  const sourceUri = resolveQueuedUploadSourceUri(item);
  if (!sourceUri) {
    return { recoverable: false, reason: 'missing-source-uri' };
  }

  if (!sourceUri.startsWith('file://')) {
    return { recoverable: true, reason: null };
  }

  try {
    const fileInfo = await FileSystem.getInfoAsync(sourceUri);
    if (!fileInfo?.exists || fileInfo?.isDirectory) {
      return { recoverable: false, reason: fileInfo?.isDirectory ? 'source-is-directory' : 'missing-local-file' };
    }
  } catch (error) {
    logger.warn('Photobook', 'Could not verify queued upload source file', {
      actionId: item?.id || null,
      error: error?.message,
    });
  }

  return { recoverable: true, reason: null };
};

export const summarizePhotos = (photos = []) => (
  Array.isArray(photos) ? photos.slice(0, 12).map((photo) => summarizePhotoRecord(photo)) : []
);

export const summarizeQueue = (items = []) => (
  Array.isArray(items) ? items.slice(0, 12).map((item) => summarizeQueueAction(item)) : []
);

export const getPhotoRowItems = (item) => (Array.isArray(item) ? item.filter(Boolean) : []);

export const summarizeRealtimeKey = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    return { present: false };
  }

  const normalized = value.trim();
  return {
    present: true,
    masked: maskIdentifier(normalized),
    length: normalized.length,
    isRealtimeSafe: !/[.#$\/\[\]\x00-\x1F\x7F]/.test(normalized),
    containsEncodedDot: normalized.includes('_2E_'),
  };
};
