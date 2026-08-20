const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createItineraryContentSignature,
  normalizeItineraryDocument,
  saveItineraryWithConflictGuard,
  validateItineraryDraft,
} = require('../services/itineraryService');
const { getTourItinerary } = require('../services/bookingServiceRealtime');

const createDb = (initialValue) => {
  let value = initialValue;
  let path = null;
  return {
    db: {
      ref: (nextPath) => {
        path = nextPath;
        return {
          transaction: async (updater) => {
            const nextValue = updater(value);
            if (nextValue === undefined) {
              return { committed: false, snapshot: { val: () => value } };
            }
            value = nextValue;
            return { committed: true, snapshot: { val: () => value } };
          },
        };
      },
    },
    getValue: () => value,
    getPath: () => path,
  };
};

test('itinerary signatures ignore sync metadata but detect operational content changes', () => {
  const base = { title: 'Tour', days: [{ day: 1, content: 'Luss' }] };
  const metadataOnly = { ...base, revision: 4, updatedAt: 123, updatedBy: 'driver-1' };
  const changed = { ...metadataOnly, days: [{ day: 1, content: 'Balloch' }] };

  assert.equal(createItineraryContentSignature(base), createItineraryContentSignature(metadataOnly));
  assert.notEqual(createItineraryContentSignature(base), createItineraryContentSignature(changed));
});

test('conflict-guarded save increments revision and records author without losing day fields', async () => {
  const current = {
    title: 'Tour',
    days: [{ day: 1, content: 'Luss', activities: [{ time: '10:00', description: 'Walk' }] }],
    revision: 2,
  };
  const harness = createDb(current);
  const result = await saveItineraryWithConflictGuard({
    tourId: 'TOUR 1',
    draft: { ...current, days: [{ ...current.days[0], content: 'Luss pier' }] },
    expectedContentSignature: createItineraryContentSignature(current),
    updatedBy: 'driver-auth-1',
    db: harness.db,
    now: 1786525200000,
  });

  assert.equal(result.success, true);
  assert.equal(harness.getPath(), 'tours/TOUR_1/itinerary');
  assert.equal(result.itinerary.revision, 3);
  assert.equal(result.itinerary.updatedBy, 'driver-auth-1');
  assert.equal(result.itinerary.days[0].activities[0].description, 'Walk');
  assert.equal(result.itinerary.days[0].content, 'Luss pier');
});

test('conflict-guarded save protects a newer server itinerary from stale overwrite', async () => {
  const editBase = { title: 'Tour', days: [{ day: 1, content: 'Luss' }] };
  const serverValue = { title: 'Tour', days: [{ day: 1, content: 'Updated pickup at Balloch' }], revision: 7 };
  const harness = createDb(serverValue);

  const result = await saveItineraryWithConflictGuard({
    tourId: 'TOUR_1',
    draft: { title: 'Tour', days: [{ day: 1, content: 'My stale edit' }] },
    expectedContentSignature: createItineraryContentSignature(editBase),
    updatedBy: 'driver-auth-1',
    db: harness.db,
  });

  assert.equal(result.success, false);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.serverItinerary, serverValue);
  assert.deepEqual(harness.getValue(), serverValue);
});

test('itinerary validation blocks empty, malformed, and excessive content before Firebase', async () => {
  assert.equal(validateItineraryDraft({ title: 'Tour', days: [] }).valid, false);
  assert.equal(validateItineraryDraft({ title: 'Tour', days: [{ day: 1 }] }).valid, false);
  assert.equal(validateItineraryDraft({
    title: 'Tour',
    days: [{ day: 1, content: 'x'.repeat(12001) }],
  }).valid, false);
});

test('normalizes legacy activity-only days into readable mobile content without losing fields', () => {
  const normalized = normalizeItineraryDocument({
    title: '  Highland tour  ',
    days: [{
      day: 8,
      title: 'Arrival',
      activities: [
        { time: '09:00', description: 'Meet the coach' },
        { description: 'Travel to Luss' },
      ],
    }],
  });

  assert.equal(normalized.title, 'Highland tour');
  assert.equal(normalized.days[0].day, 1);
  assert.equal(normalized.days[0].content, '09:00 Meet the coach\nTravel to Luss');
  assert.equal(normalized.days[0].activities[0].description, 'Meet the coach');
});

test('itinerary repository reads only the itinerary branch and distinguishes absence from failure', async () => {
  let readPath = null;
  const stored = { title: 'Tour', days: [{ day: 1, content: 'Luss' }] };
  const db = {
    ref: (path) => {
      readPath = path;
      return { once: async () => ({ exists: () => true, val: () => stored }) };
    },
  };

  const loaded = await getTourItinerary('tour 1', db);
  assert.equal(readPath, 'tours/TOUR_1/itinerary');
  assert.deepEqual(loaded, stored);

  const missing = await getTourItinerary('TOUR_1', {
    ref: () => ({ once: async () => ({ exists: () => false, val: () => null }) }),
  });
  assert.equal(missing, null);

  await assert.rejects(
    getTourItinerary('TOUR_1', {
      ref: () => ({ once: async () => { throw new Error('network unavailable'); } }),
    }),
    /network unavailable/,
  );
});
