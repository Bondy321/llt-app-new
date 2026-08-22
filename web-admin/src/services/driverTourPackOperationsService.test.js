import { describe, expect, it, vi } from 'vitest';
import {
  buildDriverTourPackOperationsByTour,
  sanitizeDriverTourPackIssues,
  sanitizeDriverTourPackProgress,
  updateDriverTourPackIssueStatus,
} from './driverTourPackOperationsService';

const departureKey = '2026-09-10::5001D_1';

describe('Driver Tour Pack operations visibility', () => {
  it('retains only the server projection allowlist and drops free text', () => {
    const progress = sanitizeDriverTourPackProgress({
      'D-100': {
        departureKey, tourId: '5001D_1', driverId: 'D-100', packRevision: 2, updatedAtMs: 100,
        revisionAcknowledged: 2, acknowledgementCurrent: true, pickupCompleted: 1, pickupTotal: 2,
        serviceCompleted: 0, serviceTotal: 1, hotelCompleted: 1, hotelTotal: 1,
        openIssueCount: 1, criticalIssueCount: 0, passenger: 'never retain',
      },
    }, departureKey);
    expect(progress['D-100']).toEqual({
      departureKey, tourId: '5001D_1', driverId: 'D-100', packRevision: 2, updatedAtMs: 100,
      revisionAcknowledged: 2, acknowledgementCurrent: true, pickupCompleted: 1, pickupTotal: 2,
      serviceCompleted: 0, serviceTotal: 1, hotelCompleted: 1, hotelTotal: 1,
      openIssueCount: 1, criticalIssueCount: 0,
    });
    const issues = sanitizeDriverTourPackIssues({
      projection_v2: { projectionId: 'projection_v2', issueId: 'issue_001', departureKey, tourId: '5001D_1', driverId: 'D-100', category: 'delay', severity: 'warning', status: 'open', revision: 2, createdAtMs: 90, updatedAtMs: 100, summary: 'Private passenger detail' },
    });
    expect(issues.projection_v2).not.toHaveProperty('summary');
  });

  it('joins only exact dated departures and marks old operations stale', () => {
    const progressEntry = { departureKey, tourId: '5001D_1', driverId: 'D-100', updatedAtMs: 100, packRevision: 1, revisionAcknowledged: 0, acknowledgementCurrent: false };
    const issue = { issueId: 'issue_001', departureKey, tourId: '5001D_1', driverId: 'D-100', category: 'delay', severity: 'warning', status: 'open', createdAtMs: 100, updatedAtMs: 100 };
    const model = buildDriverTourPackOperationsByTour({
      tours: { '5001D_1': { startDate: '10/09/2026' }, LEGACY: {} },
      progress: { [departureKey]: { 'D-100': progressEntry } },
      issues: { issue_001: issue },
      nowMs: 101,
    });
    expect(model['5001D_1']).toMatchObject({ state: 'ready', issues: [{ issueId: 'issue_001' }] });
    expect(model.LEGACY.state).toBe('ambiguous');
    expect(buildDriverTourPackOperationsByTour({ tours: { '5001D_1': { startDate: '10/09/2026' } }, progress: { [departureKey]: { 'D-100': { ...progressEntry, updatedAtMs: 1 } } }, nowMs: 86_400_002 })['5001D_1'].state).toBe('stale');
  });

  it('updates only approved action issue status leaves using the backend enum', async () => {
    const update = vi.fn().mockResolvedValue();
    const ref = vi.fn((_database, path) => ({ path }));
    await updateDriverTourPackIssueStatus({}, { departureKey, driverId: 'D-100', issueId: 'issue_001', status: 'acknowledged', nowMs: 123 }, { updateFn: update, refFn: ref });
    expect(update).toHaveBeenCalledWith(
      { path: `driver_tour_pack_actions/${departureKey}/D-100/issues/issue_001` },
      { status: 'acknowledged', updatedAtMs: 123, statusUpdatedAtMs: 123, statusUpdatedBy: 'operations' },
    );
  });

  it('indexes issues once instead of rescanning the issue set for every visible tour', () => {
    let departureKeyReads = 0;
    const tours = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
      `TOUR_${index}`,
      { startDate: '10/09/2026' },
    ]));
    const issues = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
      const tourId = `TOUR_${index % 500}`;
      const key = `2026-09-10::${tourId}`;
      const issue = {
        issueId: `issue_${index}`,
        tourId,
        driverId: 'D-100',
        category: 'delay',
        severity: 'warning',
        status: 'open',
        createdAtMs: 100,
        updatedAtMs: 100,
      };
      Object.defineProperty(issue, 'departureKey', {
        enumerable: true,
        get() {
          departureKeyReads += 1;
          return key;
        },
      });
      return [`issue_${index}`, issue];
    }));

    const model = buildDriverTourPackOperationsByTour({ tours, issues, nowMs: 101 });
    expect(Object.keys(model)).toHaveLength(500);
    expect(departureKeyReads).toBeLessThan(10_000);
  });
});
