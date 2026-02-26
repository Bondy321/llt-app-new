import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUnassignedTourTriage } from './triageGaps.js';

const TODAY = new Date(2026, 0, 28, 9, 0, 0);

test('triage matrix: supported and unsupported date inputs are classified correctly', () => {
  const tours = {
    ukValid: { name: 'UK Valid', startDate: '28/01/2026', driverName: 'TBA' },
    isoValid: { name: 'ISO Valid', startDate: '2026-01-29', driverName: 'TBA' },
    invalidSeparator: { name: 'Bad separator', startDate: '28-01-2026', driverName: 'TBA' },
    partialDate: { name: 'Partial', startDate: '2026-01', driverName: 'TBA' },
    emptyDate: { name: 'Empty', startDate: '', driverName: 'TBA' },
    nullDate: { name: 'Nullish', startDate: null, driverName: 'TBA' },
  };

  const result = buildUnassignedTourTriage(tours, { today: TODAY, maxUpcomingDays: 7, maxActionableItems: 10 });

  assert.deepEqual(
    result.actionable.map((tour) => tour.id),
    ['ukValid', 'isoValid'],
  );
  assert.deepEqual(
    result.warnings.map((tour) => tour.id),
    ['invalidSeparator', 'emptyDate', 'nullDate', 'partialDate'],
  );
});

test('boundary dates: month/year transitions and leap-day handling', () => {
  const tours = {
    monthTransition: { name: 'Month transition', startDate: '31/01/2026', driverName: 'TBA' },
    yearTransition: { name: 'Year transition', startDate: '2026-01-01', driverName: 'TBA' },
    leapDayValidUK: { name: 'Leap UK valid', startDate: '29/02/2024', driverName: 'TBA' },
    leapDayInvalidUK: { name: 'Leap UK invalid', startDate: '29/02/2025', driverName: 'TBA' },
    leapDayValidISO: { name: 'Leap ISO valid', startDate: '2024-02-29', driverName: 'TBA' },
    leapDayInvalidISO: { name: 'Leap ISO invalid', startDate: '2025-02-29', driverName: 'TBA' },
  };

  const result = buildUnassignedTourTriage(tours, { today: TODAY, maxUpcomingDays: 1000, maxActionableItems: 20 });

  assert.deepEqual(
    result.actionable.map((tour) => tour.id),
    ['leapDayValidUK', 'leapDayValidISO', 'yearTransition', 'monthTransition'],
  );
  assert.deepEqual(
    result.warnings.map((tour) => tour.id),
    ['leapDayInvalidISO', 'leapDayInvalidUK'],
  );
});

test('assigned tours are excluded from urgency list and warning pathway', () => {
  const tours = {
    actionableUnassigned: { name: 'Needs driver', startDate: '30/01/2026', driverName: 'TBA' },
    actionableAssigned: { name: 'Already assigned', startDate: '30/01/2026', driverName: 'Driver Bond' },
    invalidUnassigned: { name: 'Bad date unassigned', startDate: '2026/01/30', driverName: 'TBA' },
    invalidAssigned: { name: 'Bad date assigned', startDate: '2026/01/30', driverName: 'Driver Smith' },
  };

  const result = buildUnassignedTourTriage(tours, { today: TODAY, maxUpcomingDays: 7, maxActionableItems: 10 });

  assert.deepEqual(result.actionable.map((tour) => tour.id), ['actionableUnassigned']);
  assert.deepEqual(result.warnings.map((tour) => tour.id), ['invalidUnassigned']);
});

test('invalid-date unassigned tours are surfaced via warnings instead of being silently dropped', () => {
  const tours = {
    hiddenBeforeRegression: { name: 'Would have been dropped', startDate: '31.01.2026', driverName: 'TBA' },
  };

  const result = buildUnassignedTourTriage(tours, { today: TODAY, maxUpcomingDays: 7, maxActionableItems: 10 });

  assert.equal(result.actionable.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].id, 'hiddenBeforeRegression');
  assert.equal(result.warnings[0].warningCode, 'UNSUPPORTED_FORMAT');
});
