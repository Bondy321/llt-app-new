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
