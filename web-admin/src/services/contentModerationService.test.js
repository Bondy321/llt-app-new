import { beforeEach, describe, expect, it, vi } from 'vitest';

const firebaseMocks = vi.hoisted(() => ({
  ref: vi.fn((_database, path) => ({ path })),
  query: vi.fn((baseRef, ...constraints) => ({ baseRef, constraints })),
  orderByChild: vi.fn((field) => ({ type: 'orderByChild', field })),
  limitToLast: vi.fn((limit) => ({ type: 'limitToLast', limit })),
  onValue: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

vi.mock('firebase/database', () => firebaseMocks);

import {
  CONTENT_REPORT_STATUS,
  buildContentReportStats,
  filterContentReports,
  normalizeContentReport,
  removeReportedContent,
  subscribeToContentReports,
} from './contentModerationService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('contentModerationService', () => {
  it('normalizes report payloads and filters active reports', () => {
    const reports = [
      normalizeContentReport('older', {
        status: 'dismissed',
        contentType: 'chat_message',
        contentId: 'msg-1',
        tourId: 'TOUR_1',
        reason: 'harassment',
        reporterName: 'Reporter',
        contentPreview: 'older',
        createdAtMs: 100,
      }),
      normalizeContentReport('newer', {
        status: 'reviewing',
        contentType: 'group_photo',
        contentId: 'photo-1',
        tourId: 'TOUR_1',
        reason: 'privacy_or_safety',
        reporterName: 'Reporter',
        contentPreview: 'newer',
        createdAtMs: 200,
      }),
    ];

    expect(filterContentReports(reports, 'active').map((report) => report.id)).toEqual(['newer']);
    expect(filterContentReports(reports, 'all')).toHaveLength(2);
    expect(buildContentReportStats(reports)).toEqual({
      totalCount: 2,
      activeCount: 1,
      byStatus: {
        dismissed: 1,
        reviewing: 1,
      },
    });
  });

  it('subscribes to a bounded createdAtMs report query newest first', () => {
    const unsubscribe = vi.fn();
    firebaseMocks.onValue.mockImplementation((_queryRef, onNext) => {
      onNext({
        val: () => ({
          older: { status: 'open', createdAtMs: 100, contentType: 'chat_message' },
          newer: { status: 'reviewing', createdAtMs: 200, contentType: 'group_photo' },
        }),
      });
      return unsubscribe;
    });

    const onNext = vi.fn();
    const result = subscribeToContentReports({}, { limit: 25 }, onNext, vi.fn());

    expect(result).toBe(unsubscribe);
    expect(firebaseMocks.ref).toHaveBeenCalledWith({}, 'content_reports');
    expect(firebaseMocks.orderByChild).toHaveBeenCalledWith('createdAtMs');
    expect(firebaseMocks.limitToLast).toHaveBeenCalledWith(25);
    expect(onNext.mock.calls[0][0].map((report) => report.id)).toEqual(['newer', 'older']);
  });

  it('removes only supported reported content paths and marks the report actioned', async () => {
    firebaseMocks.remove.mockResolvedValue();
    firebaseMocks.update.mockResolvedValue();

    const result = await removeReportedContent({}, {
      id: 'report-1',
      sourcePath: 'group_tour_photos/TOUR_1/photo_1',
    });

    expect(result).toEqual({ contentPath: 'group_tour_photos/TOUR_1/photo_1' });
    expect(firebaseMocks.remove).toHaveBeenCalledWith({ path: 'group_tour_photos/TOUR_1/photo_1' });
    expect(firebaseMocks.update).toHaveBeenCalledWith({ path: 'content_reports/report-1' }, {
      status: CONTENT_REPORT_STATUS.ACTIONED,
      updatedAt: expect.any(String),
      updatedAtMs: expect.any(Number),
    });
  });

  it('rejects unsupported removal paths', async () => {
    await expect(removeReportedContent({}, {
      id: 'report-1',
      sourcePath: 'private_tour_photos/TOUR_1/user/photo_1',
    })).rejects.toThrow(/Unsupported or unsafe/);
  });
});
