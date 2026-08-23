const test = require('node:test');
const assert = require('node:assert/strict');
const {
  seatState,
  buildCoachSeatRows,
  commandCentreModel,
  manifestStatusIndex,
  selectNextEvent,
} = require('../services/driverTourPackCommandCentre');

const seats = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => {
  const number = from + index;
  return { seatId: `seat_${number}`, label: `S${number}`, displayState: 'Empty' };
});

test('builds the 53-seat coach with an aisle, left-only rows 7 and 8, and a five-seat back row', () => {
  const rows = buildCoachSeatRows(seats(1, 53));

  assert.equal(rows.length, 14);
  assert.deepEqual(rows[0].left.map((seat) => seat.label), ['S1', 'S2']);
  assert.deepEqual(rows[0].right.map((seat) => seat.label), ['S3', 'S4']);
  assert.deepEqual(rows[6].left.map((seat) => seat.label), ['S25', 'S26']);
  assert.deepEqual(rows[6].right, []);
  assert.deepEqual(rows[7].left.map((seat) => seat.label), ['S27', 'S28']);
  assert.deepEqual(rows[7].right, []);
  assert.deepEqual(rows[8].left.map((seat) => seat.label), ['S29', 'S30']);
  assert.deepEqual(rows[8].right.map((seat) => seat.label), ['S31', 'S32']);
  assert.equal(rows[13].kind, 'back');
  assert.deepEqual(rows[13].seats.map((seat) => seat.label), ['S49', 'S50', 'S51', 'S52', 'S53']);
});

test('maps authoritative per-seat manifest status without using names', () => {
  const index = manifestStatusIndex({ bookings: [{ id: 'B1', seatLabels: ['1A', '1B'], passengerStatus: ['boarded', 'no_show'] }] });
  assert.equal(index.get('B1::1A'), 'boarded');
  assert.equal(index.get('B1::1B'), 'no_show');
  assert.equal(seatState({ state: 'occupied' }, { sourceState: 'MATCHED' }, index.get('B1::1A')), 'Boarded');
  assert.equal(seatState({ state: 'occupied' }, { sourceState: 'MATCHED' }, index.get('B1::1B')), 'No-show');
});

test('unresolved occupants are counted once even when their seat is also unresolved', () => {
  const pack = { pickups:{p:{pickupId:'p',sequence:0,time:'08:00'}}, passengers:{x:{passengerKey:'x',pickupId:'p',seatLabel:'1A',sourceState:'PAX_ONLY'}}, seats:{s:{seatId:'s',label:'1A',state:'unmatched',passengerKey:'x'}}, timeline:{}, quality:{ pickupManifestPublishable: true } };
  assert.equal(commandCentreModel(pack, null).unresolved, 1);
});

test('selects the first future event rather than a completed timeline entry', () => {
  const timeline = [
    { eventId: 'past', dateISO: '2026-08-20', time: '08:00' },
    { eventId: 'next', dateISO: '2026-08-21', time: '12:30' },
    { eventId: 'later', dateISO: '2026-08-22', time: '09:00' },
  ];
  assert.equal(selectNextEvent(timeline, new Date('2026-08-21T10:00:00').getTime()).eventId, 'next');
  assert.equal(selectNextEvent(timeline, new Date('2026-08-23T10:00:00').getTime()), null);
});

test('derives stop progress from manifest authority and retains passengers without pickups', () => {
  const pack = {
    dateISO: '2026-08-21',
    pickups: { p1: { pickupId: 'p1', sequence: 0, time: '08:00', passengerCount: 2, bookingCount: 1 } },
    passengers: {
      one: { passengerKey: 'one', bookingRef: 'B1', pickupId: 'p1', seatLabel: '1A', sourceState: 'MATCHED' },
      two: { passengerKey: 'two', bookingRef: 'B1', pickupId: 'p1', seatLabel: '1B', sourceState: 'MATCHED' },
      three: { passengerKey: 'three', bookingRef: 'B2', pickupId: '', seatLabel: '', sourceState: 'UNSEATED_PAX' },
    },
    seats: {},
    timeline: {},
    quality: { pickupManifestPublishable: true },
  };
  const manifest = { bookings: [{ id: 'b1', seatLabels: ['1a', '1b'], passengerStatus: ['BOARDED', 'NO_SHOW'] }] };
  const model = commandCentreModel(pack, manifest);
  assert.deepEqual(model.pickups[0].progress, { total: 2, boarded: 1, pending: 0, noShow: 1, unresolved: 0 });
  assert.equal(model.pickups[1].pickup.name, 'Pickup details unavailable');
  assert.equal(model.pickups[1].progress.unresolved, 1);
  assert.deepEqual(model.progress, { total: 3, boarded: 1, pending: 0, noShow: 1, unresolved: 1 });
});

test('fails closed when reconciliation withholds the report pickup manifest', () => {
  const pack = {
    dateISO: '2026-08-21',
    pickups: { p1: { pickupId: 'p1', sequence: 0, name: 'Balloch', time: '08:00' } },
    passengers: { one: { passengerKey: 'one', bookingRef: 'B1', pickupId: 'p1', name: 'Alex', note: 'Driver-only note' } },
    seats: { s1: { seatId: 's1', label: 'S1', state: 'occupied', passengerKey: 'one' } },
    timeline: {},
    quality: { pickupManifestPublishable: false },
  };

  const model = commandCentreModel(pack, { bookings: [{ id: 'B1', seatLabels: ['S1'] }] });
  assert.equal(model.pickupManifestAvailable, false);
  assert.deepEqual(model.pickups, []);
  assert.deepEqual(model.passengers, []);
  assert.deepEqual(model.seats, []);
  assert.equal(model.unresolved, 0);
  assert.match(model.qualityIssues[0], /withheld.*authoritative boarding manifest/i);
});
