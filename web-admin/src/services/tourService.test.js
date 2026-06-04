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

describe('generateTourId normalization', () => {
  it('normalizes casing/spacing and removes firebase-invalid key characters', async () => {
    const { generateTourId } = await import('./tourService.js');

    expect(generateTourId(' 5112d 8 ')).toBe('5112D_8');
    expect(generateTourId('ops.#$[]/ tour')).toBe('OPS_TOUR');
  });

  it('falls back to generated id when normalization removes all content', async () => {
    const { generateTourId } = await import('./tourService.js');

    expect(generateTourId(' ///  ###  ')).toMatch(/^TOUR_[A-Z0-9]+_[A-Z0-9]{4}$/);
  });
});

describe('tour identity invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMock.mockResolvedValue(undefined);
    updateMock.mockResolvedValue(undefined);
  });

  it('refuses to create a tour when the generated Firebase key already exists', async () => {
    getMock.mockResolvedValue(buildSnapshot({ name: 'Existing Highlands' }));

    const { createTour } = await import('./tourService.js');

    await expect(createTour({
      name: 'New Highlands',
      tourCode: '5112D 8',
    })).rejects.toThrow(/already exists at tours\/5112D_8/);

    expect(setMock).not.toHaveBeenCalled();
  });

  it('creates new tours at the generated key and stores a trimmed display code', async () => {
    getMock.mockResolvedValue(buildSnapshot(null));

    const { createTour } = await import('./tourService.js');
    const result = await createTour({
      name: 'Highlands',
      tourCode: ' 5112D 8 ',
    });

    expect(result.id).toBe('5112D_8');
    expect(result.tour.tourCode).toBe('5112D 8');
    expect(setMock).toHaveBeenCalledWith(
      { path: 'tours/5112D_8' },
      expect.objectContaining({
        name: 'Highlands',
        tourCode: '5112D 8',
      }),
    );
  });

  it('rejects tourCode changes on existing tours', async () => {
    getMock.mockResolvedValue(buildSnapshot({ tourCode: '5112D 8' }));

    const { updateTour } = await import('./tourService.js');

    await expect(updateTour('5112D_8', {
      name: 'Changed Tour',
      tourCode: '6000A 1',
    })).rejects.toThrow(/Tour code cannot be changed/);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('allows updates that keep the existing tourCode identity', async () => {
    getMock.mockResolvedValue(buildSnapshot({ tourCode: '5112D 8' }));

    const { updateTour } = await import('./tourService.js');
    await updateTour('5112D_8', {
      name: 'Highlands Updated',
      tourCode: ' 5112d   8 ',
    });

    expect(updateMock).toHaveBeenCalledWith(
      { path: 'tours/5112D_8' },
      {
        name: 'Highlands Updated',
        tourCode: '5112D 8',
      },
    );
  });

  it('generates the next available copy code when duplicating a tour', async () => {
    const pathValues = {
      'tours/TOUR_A': {
        name: 'Original Tour',
        tourCode: 'TA 1',
        driverName: 'Assigned Driver',
        driverPhone: '+441234',
        currentParticipants: 12,
      },
      'tours/TA_1_COPY': { name: 'Existing Copy' },
      'tours/TA_1_COPY_2': null,
    };
    getMock.mockImplementation(async ({ path }) => buildSnapshot(pathValues[path]));

    const { duplicateTour } = await import('./tourService.js');
    const result = await duplicateTour('TOUR_A');

    expect(result.id).toBe('TA_1_COPY_2');
    expect(result.tour).toMatchObject({
      name: 'Original Tour (Copy)',
      tourCode: 'TA 1_COPY_2',
      driverName: 'TBA',
      driverPhone: '',
      currentParticipants: 0,
    });
    expect(setMock).toHaveBeenCalledWith(
      { path: 'tours/TA_1_COPY_2' },
      expect.objectContaining({ tourCode: 'TA 1_COPY_2' }),
    );
  });
});


describe('buildDriverAssignmentUpdates', () => {
  it('writes canonical assigned_driver_codes payload on assignment', async () => {
    const { buildDriverAssignmentUpdates } = await import('./tourService.js');

    const updates = buildDriverAssignmentUpdates({
      tourId: '5112d 8',
      driverId: 'D-BONDY',
      driverCode: 'D-BONDY',
      tourCode: '5112D 8',
      driverInfo: { name: 'James Bondy', phone: '+441234', authUid: 'driver-auth-1' },
      isAssigned: true,
      actorId: 'uid_web_admin_1',
      assignedAt: '2026-02-01T10:15:00.000Z',
    });

    expect(updates['tour_manifests/5112D_8/assigned_driver_codes/D-BONDY']).toEqual({
      driverId: 'D-BONDY',
      tourId: '5112D_8',
      tourCode: '5112D 8',
      assignedAt: '2026-02-01T10:15:00.000Z',
      assignedBy: 'uid_web_admin_1',
    });
    expect(updates['users/driver-auth-1/driverId']).toBe('D-BONDY');
    expect(updates['users/driver-auth-1/driverPrincipalId']).toBe('driver:D-BONDY');
    expect(updates['users/driver-auth-1/driverAssignedTourId']).toBe('5112D_8');
    expect(updates['users/driver-auth-1/principalType']).toBe('driver');
    expect(updates['users/driver-auth-1/lastUpdated']).toEqual(expect.any(Number));
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
      'drivers/D-ALICE': { assignments: {}, authUid: 'driver-auth-alice' },
    });

    const { assignDriver } = await import('./tourService.js');
    await assignDriver('TOUR_A', 'D-ALICE', { name: 'Alice', phone: '+44' });

    const [, updates] = updateMock.mock.calls[0];
    expect(updates['drivers/D-ALICE/currentTourId']).toBe('TOUR_A');
    expect(updates['drivers/D-ALICE/currentTourCode']).toBe('5100D 1');
    expect(updates['drivers/D-ALICE/assignments/TOUR_A']).toBe(true);
    expect(updates['tour_manifests/TOUR_A/assigned_drivers/D-ALICE']).toBe(true);
    expect(updates['tour_manifests/TOUR_A/assigned_driver_codes/D-ALICE']).toMatchObject({
      driverId: 'D-ALICE',
      tourId: 'TOUR_A',
      tourCode: '5100D 1',
    });
    expect(updates['users/driver-auth-alice/driverId']).toBe('D-ALICE');
    expect(updates['users/driver-auth-alice/driverAssignedTourId']).toBe('TOUR_A');
  });

  it('reassign old->new clears old manifest links in same multi-path update', async () => {
    setupPathSnapshots({
      'tours/TOUR_NEW': { tourCode: '5100D 2' },
      'tour_manifests/TOUR_NEW': { assigned_drivers: {} },
      'drivers/D-ALICE': {
        currentTourId: 'TOUR OLD',
        assignments: { TOUR_OLD: true },
      },
    });

    const { assignDriver } = await import('./tourService.js');
    await assignDriver('TOUR_NEW', 'D-ALICE', { name: 'Alice', phone: '+44' });

    const [, updates] = updateMock.mock.calls[0];
    expect(updates['drivers/D-ALICE/assignments/TOUR_OLD']).toBeNull();
    expect(updates['tour_manifests/TOUR_OLD/assigned_drivers/D-ALICE']).toBeNull();
    expect(updates['tour_manifests/TOUR_OLD/assigned_driver_codes/D-ALICE']).toBeNull();
    expect(updates['tours/TOUR_OLD/driverName']).toBe('TBA');
    expect(updates['tours/TOUR_OLD/driverPhone']).toBe('');
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
      'drivers/D-OLD': { currentTourId: 'TOUR_A', authUid: 'old-auth-uid' },
      'drivers/D-STALE': { currentTourId: ' /// ### ' },
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
    expect(updates['drivers/D-OLD/currentTourId']).toBeNull();
    expect(updates['drivers/D-OLD/currentTourCode']).toBeNull();
    expect(updates['drivers/D-STALE/currentTourId']).toBeNull();
    expect(updates['users/old-auth-uid/driverAssignedTourId']).toBeNull();
    expect(updates['tour_manifests/TOUR_A/assigned_drivers/D-NEW']).toBe(true);
  });

  it('can update driver profile details in the same assignment mutation', async () => {
    setupPathSnapshots({
      'tours/TOUR_A': { tourCode: '5100D 1' },
      'tour_manifests/TOUR_A': { assigned_drivers: {} },
      'drivers/D-ALICE': { assignments: {} },
    });

    const { applyDriverAssignmentMutation } = await import('./tourService.js');
    await applyDriverAssignmentMutation({
      tourId: 'TOUR_A',
      driverId: 'D-ALICE',
      driverInfo: { name: 'Alice Updated', phone: '+44 7000' },
      isAssigned: true,
      driverProfileUpdates: { name: 'Alice Updated', phone: '+44 7000' },
    });

    const [, updates] = updateMock.mock.calls[0];
    expect(updates['drivers/D-ALICE/name']).toBe('Alice Updated');
    expect(updates['drivers/D-ALICE/phone']).toBe('+44 7000');
    expect(updates['tours/TOUR_A/driverName']).toBe('Alice Updated');
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
