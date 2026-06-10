// services/contentModerationService.js
// Shared helpers for user-generated content reports and lightweight submission filtering.
const isTestEnv = process.env.NODE_ENV === 'test';
let realtimeDb;

if (!isTestEnv) {
  try {
    ({ realtimeDb } = require('../firebase'));
  } catch (error) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('Realtime database module not initialized during content moderation load:', error.message);
    }
  }
}

const { loadOptionalService } = require('./optionalServiceLoader');

const loggerServiceModule = loadOptionalService({
  modulePath: './loggerService',
  loadModule: () => require('./loggerService'),
  serviceLabel: 'Logger service',
  isTestEnv,
});

const logger = loggerServiceModule?.default || loggerServiceModule;

const MAX_REPORT_TEXT_LENGTH = 500;
const MAX_REPORT_NAME_LENGTH = 120;
const MAX_REPORT_SOURCE_LENGTH = 260;
const MAX_REPORT_DETAILS_LENGTH = 500;

const REPORT_REASON_OPTIONS = [
  { key: 'harassment', label: 'Harassment or abuse' },
  { key: 'hate_or_threats', label: 'Hate, threat, or intimidation' },
  { key: 'explicit_or_offensive', label: 'Explicit or offensive content' },
  { key: 'spam_or_scam', label: 'Spam or scam' },
  { key: 'privacy_or_safety', label: 'Privacy or safety concern' },
  { key: 'other', label: 'Other concern' },
];

const REPORT_REASON_KEYS = new Set(REPORT_REASON_OPTIONS.map((option) => option.key));
const CONTENT_TYPES = new Set(['chat_message', 'group_photo']);
const CHAT_SCOPES = new Set(['group', 'internal']);

const OBJECTIONABLE_PATTERNS = [
  /\b(?:f+u+c+k+|f+[\W_]*u+[\W_]*c+[\W_]*k+)\b/i,
  /\b(?:c+u+n+t+|c+[\W_]*u+[\W_]*n+[\W_]*t+)\b/i,
  /\b(?:sh+i+t+|s+[\W_]*h+[\W_]*i+[\W_]*t+)\b/i,
  /\b(?:b+i+t+c+h+|b+[\W_]*i+[\W_]*t+[\W_]*c+[\W_]*h+)\b/i,
  /\b(?:p+o+r+n+|n+u+d+e+s?|s+e+x+u+a+l+)\b/i,
  /\b(?:kill\s+yourself|kys)\b/i,
];

const safeString = (value, maxLength = MAX_REPORT_TEXT_LENGTH) => {
  if (value === null || value === undefined) return '';
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
};

const requiredString = (value, label, maxLength = MAX_REPORT_TEXT_LENGTH) => {
  const normalized = safeString(value, maxLength);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
};

const normalizeReportReason = (reason) => {
  const normalized = safeString(reason, 80).toLowerCase();
  return REPORT_REASON_KEYS.has(normalized) ? normalized : 'other';
};

const normalizeContentType = (contentType) => {
  const normalized = safeString(contentType, 80).toLowerCase();
  if (!CONTENT_TYPES.has(normalized)) {
    throw new Error('Unsupported content report type');
  }
  return normalized;
};

const normalizeChatScope = (scope) => {
  const normalized = safeString(scope, 40).toLowerCase();
  return CHAT_SCOPES.has(normalized) ? normalized : null;
};

const buildReportId = (createdAtMs) =>
  `report_${createdAtMs}_${Math.random().toString(36).slice(2, 10)}`;

const checkTextForObjectionableContent = (text) => {
  const normalized = safeString(text, 10000);
  if (!normalized) {
    return { allowed: true, text: normalized };
  }

  const matched = OBJECTIONABLE_PATTERNS.some((pattern) => pattern.test(normalized));
  if (!matched) {
    return { allowed: true, text: normalized };
  }

  return {
    allowed: false,
    text: normalized,
    code: 'objectionable_content',
    message: 'Please remove offensive or unsafe wording before sharing.',
  };
};

const assertTextPassesModeration = (text, fieldLabel = 'Content') => {
  const result = checkTextForObjectionableContent(text);
  if (!result.allowed) {
    throw new Error(`${fieldLabel} contains wording that is not allowed in the app.`);
  }
  return result.text;
};

const createContentReport = async (
  payload = {},
  {
    dbInstance = realtimeDb,
    nowFn = Date.now,
  } = {},
) => {
  const db = dbInstance || realtimeDb;
  if (!db || typeof db.ref !== 'function') {
    return { success: false, error: 'Realtime database unavailable' };
  }

  try {
    const createdAtMs = Number(nowFn());
    const safeCreatedAtMs = Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : Date.now();
    const createdAt = new Date(safeCreatedAtMs).toISOString();
    const contentType = normalizeContentType(payload.contentType);
    const reason = normalizeReportReason(payload.reason);
    const reporterId = requiredString(payload.reporterId, 'Reporter ID', 160);
    const reporterAuthUid = requiredString(payload.reporterAuthUid, 'Reporter auth UID', 160);
    const tourId = requiredString(payload.tourId, 'Tour ID', 160);
    const contentId = requiredString(payload.contentId, 'Content ID', 160);

    const reportsRef = db.ref('content_reports');
    const pushedRef = typeof reportsRef.push === 'function' ? reportsRef.push() : null;
    const reportId = safeString(pushedRef?.key, 160) || buildReportId(safeCreatedAtMs);
    const reportRef = pushedRef && typeof pushedRef.set === 'function'
      ? pushedRef
      : db.ref(`content_reports/${reportId}`);

    const report = {
      schemaVersion: 1,
      reportId,
      tourId,
      contentType,
      contentId,
      reason,
      status: 'open',
      reporterId,
      reporterAuthUid,
      reporterName: safeString(payload.reporterName, MAX_REPORT_NAME_LENGTH),
      contentOwnerId: safeString(payload.contentOwnerId, 160),
      contentOwnerName: safeString(payload.contentOwnerName, MAX_REPORT_NAME_LENGTH),
      contentPreview: safeString(payload.contentPreview, MAX_REPORT_TEXT_LENGTH),
      sourcePath: safeString(payload.sourcePath, MAX_REPORT_SOURCE_LENGTH),
      details: safeString(payload.details, MAX_REPORT_DETAILS_LENGTH),
      createdAt,
      createdAtMs: safeCreatedAtMs,
      updatedAt: createdAt,
      updatedAtMs: safeCreatedAtMs,
    };

    const chatScope = normalizeChatScope(payload.chatScope);
    if (chatScope) report.chatScope = chatScope;

    await reportRef.set(report);

    logger?.info?.('ContentModeration', 'Content report submitted', {
      reportId,
      tourId,
      contentType,
      reason,
    });

    return { success: true, reportId, report };
  } catch (error) {
    logger?.warn?.('ContentModeration', 'Content report failed', {
      contentType: safeString(payload.contentType, 80),
      reason: safeString(payload.reason, 80),
      error: error?.message || String(error),
    });
    return { success: false, error: error?.message || 'Unable to submit report' };
  }
};

module.exports = {
  REPORT_REASON_OPTIONS,
  checkTextForObjectionableContent,
  assertTextPassesModeration,
  createContentReport,
};
