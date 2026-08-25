export const DASHBOARD_BRANCHES = {
  drivers: 'drivers',
  tours: 'tours',
  tourManifests: 'tour_manifests',
  globalSafetyAlerts: 'globalSafetyAlerts',
  broadcasts: 'broadcasts',
};

export const SAFETY_STATUS = {
  PENDING: 'pending',
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
  ESCALATED: 'escalated',
};

export const SAFETY_STATUS_OPTIONS = [
  { value: 'attention', label: 'Needs attention' },
  { value: SAFETY_STATUS.PENDING, label: 'Pending' },
  { value: SAFETY_STATUS.ACKNOWLEDGED, label: 'Acknowledged' },
  { value: SAFETY_STATUS.IN_PROGRESS, label: 'In progress' },
  { value: SAFETY_STATUS.ESCALATED, label: 'Escalated' },
  { value: SAFETY_STATUS.RESOLVED, label: 'Resolved' },
  { value: 'all', label: 'All statuses' },
];

const SAFETY_ATTENTION_STATUSES = new Set([
  SAFETY_STATUS.PENDING,
  SAFETY_STATUS.ACKNOWLEDGED,
  SAFETY_STATUS.IN_PROGRESS,
  SAFETY_STATUS.ESCALATED,
]);

const SAFETY_SEVERITY_WEIGHT = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const OPS_SEVERITY_WEIGHT = {
  critical: 4,
  error: 3,
  warning: 2,
  info: 1,
};

const DEFAULT_WINDOW = {
  maxFutureDays: 14,
  maxOverdueDays: 7,
};

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const asRecord = (value) => (isPlainObject(value) ? value : {});

const cleanString = (value, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const normalizeTourIdForKey = (value) => {
  const trimmed = cleanString(value);
  if (!trimmed) return '';

  return trimmed
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[.#$[\]/]/g, '')
    .replace(/^_+|_+$/g, '');
};

const toFiniteNumber = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const countCollection = (value) => {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && item !== undefined && item !== '').length;
  }

  if (isPlainObject(value)) {
    return Object.keys(value).length;
  }

  return 0;
};

const hasTruthyChild = (value) => Object.values(asRecord(value)).some(Boolean);

export {
  DEFAULT_WINDOW,
  OPS_SEVERITY_WEIGHT,
  SAFETY_ATTENTION_STATUSES,
  SAFETY_SEVERITY_WEIGHT,
  asRecord,
  cleanString,
  countCollection,
  hasTruthyChild,
  normalizeTourIdForKey,
  toFiniteNumber,
};
