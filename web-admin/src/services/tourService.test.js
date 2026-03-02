import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const refMock = vi.fn((_db, path) => ({ path }));

vi.mock('firebase/database', () => ({
  ref: refMock,
  push: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  get: getMock,
  onValue: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: { __mock: true },
}));

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
