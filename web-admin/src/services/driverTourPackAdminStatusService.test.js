import { describe, expect, it } from 'vitest';
import {
  buildTourPackCoverage,
  resolveTourPackAdminStatus,
  sanitizeDriverTourPackAdminStatuses,
  DRIVER_TOUR_PACK_ADMIN_STATUS_QUERY,
} from './driverTourPackAdminStatusService';

const departureKey = '2026-09-10::5001D_1';
const safeStatus = {
  schemaVersion: 1, departureKey, tourId: '5001D_1', tourCode: '5001D 1', dateISO: '2026-09-10',
  status: 'active', qualityState: 'complete', revision: 3, publishedAtMs: 1_000, expiresAtMs: 9_999,
  sourceSnapshotDate: '2026-08-21', runId: 'run_1',
};

describe('driver Tour Pack admin status', () => {
  it('uses a bounded, indexed publication query rather than downloading lifecycle history', () => {
    expect(DRIVER_TOUR_PACK_ADMIN_STATUS_QUERY).toEqual({ orderByChild: 'publishedAtMs', limit: 2_000 });
  });

  it('retains only the fixed PII-free metadata allowlist', () => {
    const sanitized = sanitizeDriverTourPackAdminStatuses({
      [departureKey]: { ...safeStatus, passengers: { pax: { name: 'Private passenger' } }, secret: 'nope' },
      malformed: { ...safeStatus, departureKey: 'bad' },
      alias: safeStatus,
    });
    expect(sanitized).toEqual({ [departureKey]: safeStatus });
  });

  it('joins packs by exact departure identity and does not guess reused legacy tour IDs', () => {
    expect(resolveTourPackAdminStatus({
      tourId: '5001D_1', tour: { startDate: '10/09/2026' }, statuses: { [departureKey]: safeStatus }, nowMs: 5_000,
    }).state).toBe('ready');
    expect(resolveTourPackAdminStatus({
      tourId: '5001D_1', tour: { startDate: '11/09/2026' }, statuses: { [departureKey]: safeStatus }, nowMs: 5_000,
    }).state).toBe('missing');
    expect(resolveTourPackAdminStatus({
      tourId: '5001D_1', tour: {}, statuses: { [departureKey]: safeStatus }, nowMs: 5_000,
    })).toMatchObject({ state: 'ambiguous' });
  });

  it('surfaces degraded, stale and assignment-versus-pack coverage without reading pack payloads', () => {
    const coverage = buildTourPackCoverage({
      tours: { '5001D_1': { startDate: '2026-09-10' } },
      drivers: { 'D-100': { currentTourId: '5001D_1' } },
      statuses: { [departureKey]: { ...safeStatus, qualityState: 'degraded' } },
      nowMs: 5_000,
    });
    expect(coverage['5001D_1']).toMatchObject({ assignedDriverCount: 1, assignmentCoverage: 'covered', pack: { state: 'degraded', revision: 3 } });

    const stale = resolveTourPackAdminStatus({
      tourId: '5001D_1', tour: { startDate: '2026-09-10' }, statuses: { [departureKey]: safeStatus }, nowMs: 10_000,
    });
    expect(stale.state).toBe('stale');
  });

  it('marks conflicting or legacy-only assignment links as uncovered', () => {
    const coverage = buildTourPackCoverage({
      tours: {
        conflict: { startDate: '2026-09-10', driverId: 'D-ONE' },
        legacy: { startDate: '2026-09-10', driverName: 'Legacy Driver' },
      },
      drivers: { 'D-TWO': { currentTourId: 'conflict' } },
      statuses: {},
    });
    expect(coverage.conflict).toMatchObject({ assignmentState: 'inconsistent', assignmentCoverage: 'inconsistent' });
    expect(coverage.legacy).toMatchObject({ assignmentState: 'legacy', assignmentCoverage: 'legacy' });
  });
});
