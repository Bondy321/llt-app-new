const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildItineraryItems,
  splitItineraryContent,
} = require('../utils/itineraryPresentation');

test('splitItineraryContent handles lines, bullets, and compact list separators', () => {
  const content = [
    '09:00 Depart hotel',
    '- 10:30 Visit Stirling Castle',
    '\u2022 Lunch; free time; Dinner at 7:30 PM',
  ].join('\n');

  assert.deepEqual(splitItineraryContent(content), [
    '09:00 Depart hotel',
    '10:30 Visit Stirling Castle',
    'Lunch',
    'free time',
    'Dinner at 7:30 PM',
  ]);
});

test('splitItineraryContent avoids splitting ordinary hyphenated prose', () => {
  const content = 'Full-day visit to loch-side villages with guide-led stories and photo stops.';

  assert.deepEqual(splitItineraryContent(content), [
    'Full-day visit to loch-side villages with guide-led stories and photo stops.',
  ]);
});

test('splitItineraryContent avoids splitting ordinary semicolon prose', () => {
  const content = 'The morning is relaxed; enjoy the views from the coach.';

  assert.deepEqual(splitItineraryContent(content), [
    'The morning is relaxed; enjoy the views from the coach.',
  ]);
});

test('buildItineraryItems returns stable full-day highlights without timing metadata', () => {
  const content = '08:00 Pickup from hotel\nLunch at loch viewpoint\nDinner at 7:30 PM\nDepart at 09:00 for Fort William';
  const first = buildItineraryItems(content);
  const second = buildItineraryItems(content);

  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  assert.equal(first[0].text, '08:00 Pickup from hotel');
  assert.equal(first[0].iconKey, 'bus-clock');
  assert.equal(first[1].iconKey, 'silverware-fork-knife');
  assert.equal(first[2].text, 'Dinner at 7:30 PM');
  assert.equal(first[3].text, 'Depart at 09:00 for Fort William');
  assert.equal(Object.prototype.hasOwnProperty.call(first[0], 'displayTime'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first[0], 'minutesFromMidnight'), false);
});
