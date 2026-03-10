import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const updateMock = vi.fn();
const setMock = vi.fn();
const refMock = vi.fn((_db, path = '') => ({ path }));

vi.mock('firebase/database', () => ({
  ref: refMock,
  push: vi.fn(),
  set: setMock,
  update: updateMock,
  remove: vi.fn(),
  get: getMock,
  onValue: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: { __mock: true },
}));

const buildSnapshot = (value) => ({
  exists: () => value !== null && value !== undefined,
  val: () => value,
});

describe('tourService CSV preview integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds existing tour indices and returns update/create actions', async () => {
    getMock.mockResolvedValue({
      exists: () => true,
      val: () => ({
        tour_alpha: { tourCode: 'AB12 1', name: 'Alpha' },
        tour_beta: { tourCode: 'CD34 2', name: 'Beta' },
      }),
    });

    const { previewTourCSVImport } = await import('./tourService.js');

    const csv = [
      'Tour Code,Name,Days',
      'AB12 1,Alpha Updated,1',
      'EF56 3,Brand New,2',
    ].join('\n');

    const result = await previewTourCSVImport(csv, { mode: 'upsert' });

    expect(refMock).toHaveBeenCalledWith({ __mock: true }, 'tours');
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(result.summary.total).toBe(2);

    expect(result.rows[0].existsInDb).toBe(true);
    expect(result.rows[0].action).toBe('update');
    expect(result.rows[0].existingTourId).toBe('tour_alpha');

    expect(result.rows[1].existsInDb).toBe(false);
    expect(result.rows[1].action).toBe('create');
    expect(result.rows[1].existingTourId).toBeNull();
  });
});


describe('buildDriverAssignmentUpdates', () => {
  it('writes canonical assigned_driver_codes payload on assignment', async () => {
    const { buildDriverAssignmentUpdates } = await import('./tourService.js');

    const updates = buildDriverAssignmentUpdates({
      tourId: '5112D_8',
      driverId: 'D-BONDY',
      driverCode: 'D-BONDY',
      tourCode: '5112D 8',
      driverInfo: { name: 'James Bondy', phone: '+441234' },
      isAssigned: true,
      actorId: 'uid_web_admin_1',
      assignedAt: '2026-02-01T10:15:00.000Z',
    });

    expect(updates['tour_manifests/5112D_8/assigned_driver_codes/D-BONDY']).toEqual({
      tourId: '5112D_8',
      tourCode: '5112D 8',
      assignedAt: '2026-02-01T10:15:00.000Z',
      assignedBy: 'uid_web_admin_1',
    });
  });

  it('removes canonical payload on unassignment', async () => {
    const { buildDriverAssignmentUpdates } = await import('./tourService.js');

    const updates = buildDriverAssignmentUpdates({
      tourId: '5112D_8',
      driverId: 'D-BONDY',
      driverCode: 'D-BONDY',
      tourCode: '5112D 8',
      driverInfo: { name: 'TBA', phone: '' },
      isAssigned: false,
    });

    expect(updates['tour_manifests/5112D_8/assigned_driver_codes/D-BONDY']).toBeNull();
  });
});

describe('applyDriverAssignmentMutation integration snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockResolvedValue(undefined);
  });

  const setupPathSnapshots = (pathMap) => {
    getMock.mockImplementation(async ({ path }) => buildSnapshot(pathMap[path]));
  };

  it('assign fresh writes canonical driver/tour/manifest links', async () => {
    setupPathSnapshots({
      'tours/TOUR_A': { tourCode: '5100D 1' },
      'tour_manifests/TOUR_A': { assigned_drivers: {} },
      'drivers/D-ALICE': { assignments: {} },
    });

    const { assignDriver } = await import('./tourService.js');
    await assignDriver('TOUR_A', 'D-ALICE', { name: 'Alice', phone: '+44' });

    const [, updates] = updateMock.mock.calls[0];
    expect(updates['drivers/D-ALICE/currentTourId']).toBe('TOUR_A');
    expect(updates['drivers/D-ALICE/currentTourCode']).toBe('5100D 1');
    expect(updates['drivers/D-ALICE/assignments/TOUR_A']).toBe(true);
    expect(updates['tour_manifests/TOUR_A/assigned_drivers/D-ALICE']).toBe(true);
    expect(updates['tour_manifests/TOUR_A/assigned_driver_codes/D-ALICE']).toMatchObject({
      tourId: 'TOUR_A',
      tourCode: '5100D 1',
    });
  });

  it('reassign old->new clears old manifest links in same multi-path update', async () => {
    setupPathSnapshots({
      'tours/TOUR_NEW': { tourCode: '5100D 2' },
      'tour_manifests/TOUR_NEW': { assigned_drivers: {} },
      'drivers/D-ALICE': {
        currentTourId: 'TOUR_OLD',
        assignments: { TOUR_OLD: true },
      },
    });

    const { assignDriver } = await import('./tourService.js');
    await assignDriver('TOUR_NEW', 'D-ALICE', { name: 'Alice', phone: '+44' });

    const [, updates] = updateMock.mock.calls[0];
    expect(updates['drivers/D-ALICE/assignments/TOUR_OLD']).toBeNull();
    expect(updates['tour_manifests/TOUR_OLD/assigned_drivers/D-ALICE']).toBeNull();
    expect(updates['tour_manifests/TOUR_OLD/assigned_driver_codes/D-ALICE']).toBeNull();
    expect(updates['drivers/D-ALICE/currentTourId']).toBe('TOUR_NEW');
  });

  it('unassign removes all required paths and resets tour driver display', async () => {
    setupPathSnapshots({
      'tours/TOUR_A': { tourCode: '5100D 1' },
      'tour_manifests/TOUR_A': { assigned_drivers: { 'D-ALICE': true } },
      'drivers/D-ALICE': {
        currentTourId: 'TOUR_A',
        assignments: { TOUR_A: true },
      },
    });

    const { unassignDriver } = await import('./tourService.js');
    await unassignDriver('TOUR_A', 'D-ALICE');

    const [, updates] = updateMock.mock.calls[0];
    expect(updates['drivers/D-ALICE/currentTourId']).toBeNull();
    expect(updates['drivers/D-ALICE/currentTourCode']).toBeNull();
    expect(updates['drivers/D-ALICE/assignments/TOUR_A']).toBeNull();
    expect(updates['tour_manifests/TOUR_A/assigned_drivers/D-ALICE']).toBeNull();
    expect(updates['tour_manifests/TOUR_A/assigned_driver_codes/D-ALICE']).toBeNull();
    expect(updates['tours/TOUR_A/driverName']).toBe('TBA');
    expect(updates['tours/TOUR_A/driverPhone']).toBe('');
  });

  it('stale manifest cleanup enforces single-driver policy on target tour', async () => {
    setupPathSnapshots({
      'tours/TOUR_A': { tourCode: '5100D 1' },
      'tour_manifests/TOUR_A': {
        assigned_drivers: { 'D-OLD': true, 'D-STALE': true },
      },
      'drivers/D-NEW': { assignments: {} },
    });

    const { assignDriver } = await import('./tourService.js');
    await assignDriver('TOUR_A', 'D-NEW', { name: 'New Driver', phone: '' });

    const [, updates] = updateMock.mock.calls[0];
    expect(updates['tour_manifests/TOUR_A/assigned_drivers/D-OLD']).toBeNull();
    expect(updates['tour_manifests/TOUR_A/assigned_driver_codes/D-OLD']).toBeNull();
    expect(updates['tour_manifests/TOUR_A/assigned_drivers/D-STALE']).toBeNull();
    expect(updates['tour_manifests/TOUR_A/assigned_driver_codes/D-STALE']).toBeNull();
    expect(updates['drivers/D-OLD/assignments/TOUR_A']).toBeNull();
    expect(updates['drivers/D-STALE/assignments/TOUR_A']).toBeNull();
    expect(updates['tour_manifests/TOUR_A/assigned_drivers/D-NEW']).toBe(true);
  });
});


describe('createTourFromTemplate date anchoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives endDate from override startDate instead of current date', async () => {
    setMock.mockResolvedValue(undefined);
    const { createTourFromTemplate } = await import('./tourService.js');
    const result = await createTourFromTemplate('highlands', {
      startDate: '10/02/2026',
      tourCode: 'HL_TEST_1',
    }, 'ops@llt');

    expect(result.tour.startDate).toBe('10/02/2026');
    expect(result.tour.endDate).toBe('11/02/2026');
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});
