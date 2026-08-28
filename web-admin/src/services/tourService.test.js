import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const updateMock = vi.fn();
const runTransactionMock = vi.fn();
const refMock = vi.fn((_db, path = '') => ({ path }));
const postAdminActionMock = vi.fn();

vi.mock('firebase/database', () => ({
  ref: refMock,
  push: vi.fn(),
  update: updateMock,
  remove: vi.fn(),
  get: getMock,
  onValue: vi.fn(),
  runTransaction: runTransactionMock,
}));

vi.mock('../firebase', () => ({
  db: { __mock: true },
}));
vi.mock('./adminActionService', () => ({
  postAdminAction: postAdminActionMock,
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
    getMock.mockImplementation(async ({ path }) => ({
      exists: () => true,
      val: () => path === 'tours' ? ({
        tour_alpha: { tourCode: 'AB12 1', name: 'Alpha' },
        tour_beta: { tourCode: 'CD34 2', name: 'Beta' },
      }) : ({ 'D-ALICE': { name: 'Alice' } }),
    }));

    const { previewTourCSVImport } = await import('./tourService.js');

    const csv = [
      'Tour Code,Name,Days',
      'AB12 1,Alpha Updated,1',
      'EF56 3,Brand New,2',
    ].join('\n');

    const result = await previewTourCSVImport(csv, { mode: 'upsert' });

    expect(refMock).toHaveBeenCalledWith({ __mock: true }, 'tours');
    expect(refMock).toHaveBeenCalledWith({ __mock: true }, 'drivers');
    expect(getMock).toHaveBeenCalledTimes(2);
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
    updateMock.mockResolvedValue(undefined);
    runTransactionMock.mockImplementation(async (_target, updater) => ({
      committed: updater(null) !== undefined,
    }));
  });

  it('refuses to create a tour when the generated Firebase key already exists', async () => {
    runTransactionMock.mockImplementation(async (_target, updater) => ({
      committed: updater({ name: 'Existing Highlands' }) !== undefined,
    }));

    const { createTour } = await import('./tourService.js');

    await expect(createTour({
      name: 'New Highlands',
      tourCode: '5112D 8',
    })).rejects.toThrow(/already exists at tours\/5112D_8/);

    expect(runTransactionMock).toHaveBeenCalledWith(
      { path: 'tours/5112D_8' },
      expect.any(Function),
      { applyLocally: false },
    );
  });

  it('creates new tours at the generated key and stores a trimmed display code', async () => {
    const { createTour } = await import('./tourService.js');
    const result = await createTour({
      name: 'Highlands',
      tourCode: ' 5112D 8 ',
    });

    expect(result.id).toBe('5112D_8');
    expect(result.tour.tourCode).toBe('5112D 8');
    expect(runTransactionMock).toHaveBeenCalledWith(
      { path: 'tours/5112D_8' },
      expect.any(Function),
      { applyLocally: false },
    );
    const updater = runTransactionMock.mock.calls[0][1];
    expect(updater(null)).toEqual(expect.objectContaining({ name: 'Highlands', tourCode: '5112D 8' }));
    expect(updater({ name: 'Existing' })).toBeUndefined();
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
    expect(runTransactionMock).toHaveBeenCalledWith(
      { path: 'tours/TA_1_COPY_2' },
      expect.any(Function),
      { applyLocally: false },
    );
  });

  it('writes canonical UTC date indexes used by bounded admin queries', async () => {
    const { buildTourDateIndexFields, createTour } = await import('./tourService.js');
    expect(buildTourDateIndexFields({ startDate: '22/08/2026', endDate: '24/08/2026' })).toEqual({
      startDateEpochMs: Date.UTC(2026, 7, 22),
      endDateEpochMs: Date.UTC(2026, 7, 24),
    });
    const result = await createTour({
      name: 'Indexed Highlands',
      tourCode: 'INDEX 1',
      startDate: '22/08/2026',
      endDate: '24/08/2026',
    });
    expect(result.tour).toMatchObject({
      startDateEpochMs: Date.UTC(2026, 7, 22),
      endDateEpochMs: Date.UTC(2026, 7, 24),
    });
  });

  it('rejects create and edit operations whose end date precedes the start date', async () => {
    getMock.mockResolvedValue(buildSnapshot({
      tourCode: 'BAD 1',
      startDate: '20/08/2026',
      endDate: '21/08/2026',
    }));
    const { createTour, updateTour } = await import('./tourService.js');

    await expect(createTour({
      name: 'Impossible Tour',
      tourCode: 'BAD 1',
      startDate: '20/08/2026',
      endDate: '19/08/2026',
    })).rejects.toThrow(/end date cannot be before/i);
    await expect(updateTour('BAD_1', {
      startDate: '2026-08-20',
      endDate: '2026-08-19',
    })).rejects.toThrow(/end date cannot be before/i);

    expect(runTransactionMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('validates partial date patches against the stored counterpart and rejects missing tours', async () => {
    getMock.mockResolvedValueOnce(buildSnapshot({
      tourCode: 'DATE 1',
      startDate: '10/08/2026',
      endDate: '12/08/2026',
    }));
    const { updateTour } = await import('./tourService.js');

    await expect(updateTour('DATE_1', { endDate: '09/08/2026' }))
      .rejects.toThrow(/end date cannot be before/i);
    expect(updateMock).not.toHaveBeenCalled();

    getMock.mockResolvedValueOnce(buildSnapshot(null));
    await expect(updateTour('MISSING_1', { name: 'Ghost tour' }))
      .rejects.toThrow(/no longer exists/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not let an edit lower capacity below the trusted booked count', async () => {
    getMock.mockResolvedValue(buildSnapshot({
      tourCode: 'FULL 1',
      maxParticipants: 53,
      currentParticipants: 12,
    }));
    const { updateTour } = await import('./tourService.js');

    await expect(updateTour('FULL_1', { maxParticipants: 10 }))
      .rejects.toThrow(/cannot be lower than the booked participant count/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('duplicates only reusable tour definition fields and drops live operational state', async () => {
    const pathValues = {
      'tours/TOUR_A': {
        name: 'Original Tour',
        tourCode: 'TA 1',
        startDate: '01/09/2026',
        itinerary: { title: 'Plan', days: [{ day: 1 }] },
        participants: { user_1: true },
        safetyAlerts: { alert_1: { status: 'pending' } },
        liveTracking: { user_1: { isSharing: true } },
        driverLocation: { latitude: 1, longitude: 2 },
        bookedPassengerCount: 8,
      },
      'tours/TA_1_COPY': null,
    };
    getMock.mockImplementation(async ({ path }) => buildSnapshot(pathValues[path]));

    const { duplicateTour } = await import('./tourService.js');
    const result = await duplicateTour('TOUR_A');

    expect(result.tour.itinerary).toEqual({ title: 'Plan', days: [{ day: 1 }] });
    expect(result.tour.endDate).toBe('01/09/2026');
    expect(result.tour).not.toHaveProperty('participants');
    expect(result.tour).not.toHaveProperty('safetyAlerts');
    expect(result.tour).not.toHaveProperty('liveTracking');
    expect(result.tour).not.toHaveProperty('driverLocation');
    expect(result.tour).not.toHaveProperty('bookedPassengerCount');
  });

  it('routes tour deletion through the authenticated cleanup function', async () => {
    postAdminActionMock.mockResolvedValue({ success: true, alreadyDeleted: false, summary: { bookingsDeleted: 2 } });
    const { deleteTour } = await import('./tourService.js');

    await expect(deleteTour(' tour a ')).resolves.toEqual({
      id: 'TOUR_A',
      deleted: true,
      alreadyDeleted: false,
      summary: { bookingsDeleted: 2 },
    });
    expect(postAdminActionMock).toHaveBeenCalledWith('deleteTourData', { tourId: 'TOUR_A' }, expect.any(Object));
  });

  it('treats a retry after a completed server deletion as successful', async () => {
    postAdminActionMock.mockResolvedValue({
      success: true,
      alreadyDeleted: true,
      summary: { alreadyDeleted: true, storageObjectsDeleted: 0 },
    });
    const { deleteTour } = await import('./tourService.js');

    await expect(deleteTour('TOUR_A')).resolves.toMatchObject({
      id: 'TOUR_A',
      deleted: true,
      alreadyDeleted: true,
    });
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

describe('server-owned driver assignment mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postAdminActionMock.mockResolvedValue({ success: true });
  });

  const setupPathSnapshots = (pathMap) => {
    getMock.mockImplementation(async ({ path }) => buildSnapshot(pathMap[path]));
  };

  it('assign sends expected revisions and never writes canonical paths directly', async () => {
    setupPathSnapshots({
      'tours/TOUR_A': { tourCode: '5100D 1', driverAssignmentRevision: 7 },
      'tour_manifests/TOUR_A': { assigned_drivers: {} },
      'drivers/D-ALICE': { assignmentRevision: 3 },
    });

    const { assignDriver } = await import('./tourService.js');
    await assignDriver('TOUR_A', 'D-ALICE', { name: 'Alice', phone: '+44' });

    expect(postAdminActionMock).toHaveBeenCalledWith('assignDriverToTour', expect.objectContaining({
      operation: 'assign',
      driverId: 'D-ALICE',
      tourId: 'TOUR_A',
      expectedDriverRevision: 3,
      expectedTourRevision: 7,
      idempotencyKey: expect.stringContaining('admin-assignment:assign:TOUR_A:D-ALICE:'),
    }), expect.any(Object));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('unassign resolves the current driver and sends a revision-checked action', async () => {
    setupPathSnapshots({
      'tours/TOUR_A': { tourCode: '5100D 1', driverId: 'D-ALICE', driverAssignmentRevision: 4 },
      'tour_manifests/TOUR_A': { assigned_drivers: { 'D-ALICE': true } },
      'drivers/D-ALICE': { assignmentRevision: 9 },
    });

    const { unassignDriver } = await import('./tourService.js');
    await unassignDriver('TOUR_A');

    expect(postAdminActionMock).toHaveBeenCalledWith('assignDriverToTour', expect.objectContaining({
      operation: 'unassign',
      driverId: 'D-ALICE',
      tourId: 'TOUR_A',
      expectedDriverRevision: 9,
      expectedTourRevision: 4,
      idempotencyKey: expect.stringContaining('admin-assignment:unassign:TOUR_A:D-ALICE:'),
    }), expect.any(Object));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('keeps contact edits inside the same server-owned assignment action', async () => {
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

    expect(postAdminActionMock).toHaveBeenCalledWith('assignDriverToTour', expect.objectContaining({
      operation: 'assign',
      driverProfileUpdates: { name: 'Alice Updated', phone: '+44 7000' },
    }), expect.any(Object));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reuses the exact assignment attempt after an in-progress continuation', async () => {
    setupPathSnapshots({
      'tours/TOUR_RETRY': { tourCode: '5100D 2', driverAssignmentRevision: 6 },
      'tour_manifests/TOUR_RETRY': { assigned_drivers: {} },
      'drivers/D-RETRY': { assignmentRevision: 4 },
    });
    postAdminActionMock
      .mockRejectedValueOnce(Object.assign(new Error('still running'), { code: 'ASSIGNMENT_IN_PROGRESS' }))
      .mockResolvedValueOnce({ success: true });

    const { assignDriver } = await import('./tourService.js');
    await expect(assignDriver('TOUR_RETRY', 'D-RETRY')).rejects.toMatchObject({
      code: 'ASSIGNMENT_IN_PROGRESS',
    });
    await assignDriver('TOUR_RETRY', 'D-RETRY');

    const firstPayload = postAdminActionMock.mock.calls[0][1];
    const retryPayload = postAdminActionMock.mock.calls[1][1];
    expect(retryPayload.idempotencyKey).toBe(firstPayload.idempotencyKey);
    expect(retryPayload.expectedDriverRevision).toBe(firstPayload.expectedDriverRevision);
    expect(retryPayload.expectedTourRevision).toBe(firstPayload.expectedTourRevision);
  });
});


describe('createTourFromTemplate date anchoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTransactionMock.mockImplementation(async (_target, updater) => ({
      committed: updater(null) !== undefined,
    }));
  });

  it('derives endDate from override startDate instead of current date', async () => {
    const { createTourFromTemplate } = await import('./tourService.js');
    const result = await createTourFromTemplate('highlands', {
      startDate: '10/02/2026',
      tourCode: 'HL_TEST_1',
    }, 'ops@llt');

    expect(result.tour.startDate).toBe('10/02/2026');
    expect(result.tour.endDate).toBe('11/02/2026');
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });
});
