import { get, limitToLast, onValue, orderByChild, query, ref, remove, update } from 'firebase/database';
import {
  logFirebaseDebug,
  logFirebaseError,
  startFirebaseDebugTimer,
  summarizeDatabaseInstance,
  summarizeFirebaseSnapshot,
} from './firebaseDebug';

export const CONTENT_REPORTS_ROOT = 'content_reports';

export const CONTENT_REPORT_STATUS = {
  OPEN: 'open',
  REVIEWING: 'reviewing',
  ACTIONED: 'actioned',
  DISMISSED: 'dismissed',
};

export const CONTENT_REPORT_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: CONTENT_REPORT_STATUS.OPEN, label: 'Open' },
  { value: CONTENT_REPORT_STATUS.REVIEWING, label: 'Reviewing' },
  { value: CONTENT_REPORT_STATUS.ACTIONED, label: 'Actioned' },
  { value: CONTENT_REPORT_STATUS.DISMISSED, label: 'Dismissed' },
  { value: 'all', label: 'All statuses' },
];

const VALID_STATUSES = new Set(Object.values(CONTENT_REPORT_STATUS));
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const safeText = (value, fallback = '', maxLength = 240) => {
  const normalized = String(value ?? fallback).replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
};

const safeNumber = (value, fallback = 0) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

const normalizeStatus = (status) => (
  VALID_STATUSES.has(status) ? status : CONTENT_REPORT_STATUS.OPEN
);

export function normalizeContentReport(id, value = {}) {
  const createdAtMs = safeNumber(value.createdAtMs, 0);
  const updatedAtMs = safeNumber(value.updatedAtMs, createdAtMs);

  return {
    id,
    reportId: safeText(value.reportId, id, 160),
    tourId: safeText(value.tourId, '', 160),
    contentType: safeText(value.contentType, 'unknown', 80),
    contentId: safeText(value.contentId, '', 160),
    chatScope: value.chatScope ? safeText(value.chatScope, '', 40) : null,
    reason: safeText(value.reason, 'other', 80),
    status: normalizeStatus(value.status),
    reporterId: safeText(value.reporterId, '', 160),
    reporterName: safeText(value.reporterName, 'Reporter', 120),
    contentOwnerId: safeText(value.contentOwnerId, '', 160),
    contentOwnerName: safeText(value.contentOwnerName, 'Participant', 120),
    contentPreview: safeText(value.contentPreview, '', 500),
    sourcePath: safeText(value.sourcePath, '', 260),
    details: safeText(value.details, '', 500),
    createdAt: safeText(value.createdAt, '', 40),
    createdAtMs,
    updatedAt: safeText(value.updatedAt, '', 40),
    updatedAtMs,
  };
}

const buildReportsQuery = (database, options = {}) => {
  const safeLimit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  return query(
    ref(database, CONTENT_REPORTS_ROOT),
    orderByChild('createdAtMs'),
    limitToLast(safeLimit),
  );
};

const normalizeReportsSnapshot = (snapshot, preloadedValue = null) => {
  const raw = preloadedValue ?? snapshot.val() ?? {};
  return Object.entries(raw)
    .map(([id, value]) => normalizeContentReport(id, value || {}))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
};

export async function fetchContentReports(database, options = {}) {
  const timer = startFirebaseDebugTimer('content-reports:fetch', {
    options,
    database: summarizeDatabaseInstance(database),
  });

  try {
    const snapshot = await get(buildReportsQuery(database, options));
    const raw = snapshot.val() || {};
    const reports = normalizeReportsSnapshot(snapshot, raw);
    timer.success({
      snapshot: summarizeFirebaseSnapshot(snapshot, raw),
      normalizedReportCount: reports.length,
    });
    return reports;
  } catch (error) {
    timer.failure(error);
    throw error;
  }
}

export function subscribeToContentReports(database, options = {}, onNext, onError) {
  const reportsQuery = buildReportsQuery(database, options);
  const startedAtMs = Date.now();

  logFirebaseDebug('content-reports:subscribe:start', {
    options,
    root: CONTENT_REPORTS_ROOT,
    database: summarizeDatabaseInstance(database),
  }, 'info');

  return onValue(
    reportsQuery,
    (snapshot) => {
      const raw = snapshot.val() || {};
      const reports = normalizeReportsSnapshot(snapshot, raw);
      logFirebaseDebug('content-reports:subscribe:data', {
        elapsedSinceAttachMs: Date.now() - startedAtMs,
        snapshot: summarizeFirebaseSnapshot(snapshot, raw),
        normalizedReportCount: reports.length,
      });
      onNext?.(reports);
    },
    (error) => {
      logFirebaseError('content-reports:subscribe:error', error, {
        options,
        root: CONTENT_REPORTS_ROOT,
        database: summarizeDatabaseInstance(database),
      });
      onError?.(error);
    },
  );
}

export function filterContentReports(reports = [], statusFilter = 'active') {
  const normalizedStatus = statusFilter || 'active';
  return reports.filter((report) => {
    if (normalizedStatus === 'all') return true;
    if (normalizedStatus === 'active') {
      return report.status === CONTENT_REPORT_STATUS.OPEN || report.status === CONTENT_REPORT_STATUS.REVIEWING;
    }
    return report.status === normalizedStatus;
  });
}

export function buildContentReportStats(reports = []) {
  return reports.reduce((accumulator, report) => {
    accumulator.totalCount += 1;
    accumulator.byStatus[report.status] = (accumulator.byStatus[report.status] || 0) + 1;
    if (report.status === CONTENT_REPORT_STATUS.OPEN || report.status === CONTENT_REPORT_STATUS.REVIEWING) {
      accumulator.activeCount += 1;
    }
    return accumulator;
  }, {
    totalCount: 0,
    activeCount: 0,
    byStatus: {},
  });
}

export async function updateContentReportStatus(database, reportId, status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Unsupported content report status: ${status}`);
  }

  const now = Date.now();
  await update(ref(database, `${CONTENT_REPORTS_ROOT}/${reportId}`), {
    status,
    updatedAt: new Date(now).toISOString(),
    updatedAtMs: now,
  });
}

const resolveReportedContentPath = (report) => {
  if (report.sourcePath) return report.sourcePath;
  if (report.contentType === 'group_photo') {
    return `group_tour_photos/${report.tourId}/${report.contentId}`;
  }
  if (report.contentType === 'chat_message') {
    const root = report.chatScope === 'internal' ? 'internal_chats' : 'chats';
    return `${root}/${report.tourId}/messages/${report.contentId}`;
  }
  return null;
};

const isAllowedRemovalPath = (path) => (
  /^chats\/[^/]+\/messages\/[^/]+$/.test(path)
  || /^internal_chats\/[^/]+\/messages\/[^/]+$/.test(path)
  || /^group_tour_photos\/[^/]+\/[^/]+$/.test(path)
);

export async function removeReportedContent(database, report) {
  const contentPath = resolveReportedContentPath(report);
  if (!contentPath || !isAllowedRemovalPath(contentPath)) {
    throw new Error('Unsupported or unsafe reported content path');
  }

  await remove(ref(database, contentPath));
  await updateContentReportStatus(database, report.id, CONTENT_REPORT_STATUS.ACTIONED);
  return { contentPath };
}
