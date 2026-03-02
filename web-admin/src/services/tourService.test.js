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
