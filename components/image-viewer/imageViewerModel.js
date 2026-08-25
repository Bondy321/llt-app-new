import { normalizePhotoUri } from '../../services/photoVariantService';

export const normalizeKeyPart = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return null;

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

export const getPhotoKey = (photo, index) => {
  const candidates = [
    photo?.id,
    photo?.idempotencyKey,
    photo?.viewerStoragePath,
    photo?.thumbnailStoragePath,
    photo?.storagePath,
    photo?.viewerUrl,
    photo?.url,
  ];

  for (const candidate of candidates) {
    const key = normalizeKeyPart(candidate);
    if (key) return key;
  }

  return `${index}`;
};

export const buildImageSource = (uri, cacheKey) => {
  const normalizedUri = normalizePhotoUri(uri);
  return normalizedUri ? (cacheKey ? { uri: normalizedUri, cacheKey } : { uri: normalizedUri }) : undefined;
};

export const buildNativeImageSource = (uri) => {
  const normalizedUri = normalizePhotoUri(uri);
  return normalizedUri ? { uri: normalizedUri } : undefined;
};

export const resolveText = (value, fallback = '') => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
);
