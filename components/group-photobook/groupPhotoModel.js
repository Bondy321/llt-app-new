import { parseTimestampMs } from '../../services/timeUtils';

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

export const parseModerationMap = (value) => {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.entries(parsed).reduce((accumulator, [key, enabled]) => {
      if (enabled === true && typeof key === 'string' && key.trim()) {
        accumulator[key.trim()] = true;
      }
      return accumulator;
    }, {});
  } catch {
    return {};
  }
};
