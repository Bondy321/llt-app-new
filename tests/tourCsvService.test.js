const test = require('node:test');
const assert = require('node:assert');

const loadModule = async () => import('../web-admin/src/services/tourCsvService.js');

test('parses quoted commas, multiline fields, and escaped quotes', async () => {
  const { parseCSVWithStateMachine } = await loadModule();

  const csv = [
    'Tour Code,Name,Days,Start Date',
    '"T100","Loch, ""Lomond"" Explorer",2,2026-02-01',
    '"T101","Highlands\nAdventure",3,01/03/2026'
  ].join('\n');

  const { rows, parseErrors } = parseCSVWithStateMachine(csv);

  assert.deepEqual(parseErrors, []);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'Loch, "Lomond" Explorer');
  assert.equal(rows[2][1], 'Highlands\nAdventure');
});

test('ignores blank lines and detects malformed rows with unmatched quotes', async () => {
  const { parseCSVWithStateMachine } = await loadModule();

  const csv = [
    'Tour Code,Name',
    '',
    '"T200","Good Row"',
    '"T201","Broken Row',
  ].join('\n');

  const { rows, parseErrors } = parseCSVWithStateMachine(csv);

  assert.equal(rows.length, 3);
  assert.equal(parseErrors.length, 1);
  assert.match(parseErrors[0], /unmatched quote/i);
});

test('validates required fields, date formats, numeric ranges, and duplicates', async () => {
  const { validateTourCsvRows } = await loadModule();

  const csv = [
    'Tour Code,Name,Days,Start Date,End Date,Max Participants,Current Participants',
    'A100,Valid Tour,2,01/03/2026,2026-03-02,53,10',
    'A100,Duplicate In File,1,2026-03-01,2026-03-01,53,1',
    'A101,,0,03-01-2026,2026/03/04,0,999',
  ].join('\n');

  const existingTourCodes = new Set(['A100']);
  const existingTourCodeToId = new Map([['A100', 'A100_ID']]);

  const preview = validateTourCsvRows(csv, { mode: 'create-only', existingTourCodes, existingTourCodeToId });

  assert.equal(preview.summary.total, 3);
  assert.equal(preview.summary.valid, 0);

  const secondRow = preview.rows[1];
  assert.ok(secondRow.errors.some((e) => /duplicate tour code/i.test(e)));

  const thirdRow = preview.rows[2];
  assert.ok(thirdRow.errors.some((e) => /Name is required/i.test(e)));
  assert.ok(thirdRow.errors.some((e) => /Start Date must be dd\/MM\/yyyy or yyyy-MM-dd/i.test(e)));
  assert.ok(thirdRow.errors.some((e) => /Max Participants must be an integer between 1 and 500/i.test(e)));
});

test('builds field-preserving update patches and never erases itinerary data implicitly', async () => {
  const { validateTourCsvRows } = await loadModule();
  const preview = validateTourCsvRows([
    'Tour Code,Name,Days',
    'A100,Renamed Tour,4',
  ].join('\n'), {
    mode: 'update-existing',
    existingTourCodes: new Set(['A100']),
    existingTourCodeToId: new Map([['A100', 'A100']]),
  });

  const row = preview.rows[0];
  assert.equal(row.isValid, true);
  assert.deepEqual(row.updates, { name: 'Renamed Tour', tourCode: 'A100', days: 4 });
  assert.equal('itinerary' in row.updates, false);
  assert.equal('pickupPoints' in row.updates, false);
  assert.equal('driverName' in row.updates, false);
});

test('treats exported participant totals as read-only during import', async () => {
  const { validateTourCsvRows } = await loadModule();
  const preview = validateTourCsvRows([
    'Tour Code,Name,Max Participants,Current Participants',
    'A100,Renamed Tour,53,999',
  ].join('\n'), {
    mode: 'update-existing',
    existingTourCodes: new Set(['A100']),
    existingTourCodeToId: new Map([['A100', 'A100']]),
  });

  const row = preview.rows[0];
  assert.equal(row.isValid, true);
  assert.equal('currentParticipants' in row.updates, false);
  assert.equal(row.tour.currentParticipants, 0);
  assert.ok(row.warnings.some((warning) => /read-only and was ignored/i.test(warning)));
});

test('round-trips pickup point JSON and normalizes ISO dates to the app UK date contract', async () => {
  const { validateTourCsvRows } = await loadModule();
  const pickupJson = '[{"location":"Balloch - Station","time":"08:15"},{"location":"Luss","time":"09:00","date":"04/09/2026"}]';
  const preview = validateTourCsvRows([
    'Tour Code,Name,Start Date,End Date,Pickup Points',
    `A101,Day Trip,2026-09-04,2026-09-04,"${pickupJson.replaceAll('"', '""')}"`,
  ].join('\n'));

  const row = preview.rows[0];
  assert.equal(row.isValid, true);
  assert.equal(row.tour.startDate, '04/09/2026');
  assert.equal(row.tour.endDate, '04/09/2026');
  assert.deepEqual(row.tour.pickupPoints, [
    { location: 'Balloch - Station', time: '08:15' },
    { location: 'Luss', time: '09:00', date: '04/09/2026' },
  ]);
});

test('uses canonical driver IDs for assignment and ignores display-only driver columns', async () => {
  const { validateTourCsvRows } = await loadModule();
  const existingTourCodes = new Set(['A100']);
  const existingTourCodeToId = new Map([['A100', 'A100']]);
  const existingDrivers = new Map([['D-ALICE', { name: 'Alice Canonical', phone: '+44123', authUid: 'auth-1' }]]);

  const assigned = validateTourCsvRows([
    'Tour Code,Name,Driver,Driver ID,Driver Phone',
    'A100,Updated,Alice CSV,D-ALICE,+44999',
  ].join('\n'), { mode: 'update-existing', existingTourCodes, existingTourCodeToId, existingDrivers }).rows[0];
  assert.equal(assigned.isValid, true);
  assert.deepEqual(assigned.assignment, {
    action: 'assign',
    driverId: 'D-ALICE',
    driverInfo: { name: 'Alice Canonical', phone: '+44123', authUid: 'auth-1' },
  });
  assert.ok(assigned.warnings.length >= 1);

  const displayOnly = validateTourCsvRows([
    'Tour Code,Name,Driver,Driver Phone',
    'A100,Updated,Fake Driver,+44999',
  ].join('\n'), { mode: 'update-existing', existingTourCodes, existingTourCodeToId, existingDrivers }).rows[0];
  assert.equal(displayOnly.assignment, null);
  assert.equal('driverName' in displayOnly.updates, false);
  assert.ok(displayOnly.warnings.some((warning) => /ignored without a Driver ID/i.test(warning)));
});
