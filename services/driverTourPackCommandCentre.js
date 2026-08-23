const {
  selectOrderedPassengers,
  selectOrderedPickups,
  selectOrderedSeats,
  selectOrderedTimeline,
} = require('./driverTourPackSelectors');

const DISPLAY_STATES = Object.freeze({
  EMPTY: 'Empty',
  PENDING: 'Pending',
  BOARDED: 'Boarded',
  NO_SHOW: 'No-show',
  UNMATCHED: 'Unmatched',
  CONFLICT: 'Conflict',
});

const normalizeStatus = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[\s-]+/g, '_');
const normalizeBookingRef = (value) => String(value || '').trim().toUpperCase();
const normalizeSeatLabel = (value) => String(value || '').trim().toUpperCase();
const manifestKey = (bookingRef, seatLabel) => `${normalizeBookingRef(bookingRef)}::${normalizeSeatLabel(seatLabel)}`;

function numberedSeat(label) {
  const match = /^S?(\d+)$/.exec(normalizeSeatLabel(label));
  return match ? Number(match[1]) : null;
}

function pairedSeatRows(seats, startingRow = 1) {
  const rows = [];
  for (let index = 0; index < seats.length; index += 4) {
    const rowSeats = seats.slice(index, index + 4);
    rows.push({
      rowNumber: startingRow + rows.length,
      kind: 'standard',
      left: rowSeats.slice(0, 2),
      right: rowSeats.slice(2, 4),
    });
  }
  return rows;
}

function buildCoachSeatRows(seatsInput) {
  const seats = Array.isArray(seatsInput) ? seatsInput : [];
  const byNumber = new Map();
  const extras = [];

  seats.forEach((seat) => {
    const number = numberedSeat(seat?.label);
    if (number !== null && number >= 1 && number <= 53 && !byNumber.has(number)) byNumber.set(number, seat);
    else extras.push(seat);
  });

  const hasStandard53Layout = Array.from({ length: 53 }, (_, index) => index + 1)
    .every((number) => byNumber.has(number));
  if (!hasStandard53Layout) {
    const hasFiveSeatBackRow = seats.length >= 5 && seats.length % 4 === 1;
    const standardSeats = hasFiveSeatBackRow ? seats.slice(0, -5) : seats;
    const rows = pairedSeatRows(standardSeats);
    if (hasFiveSeatBackRow) {
      rows.push({ rowNumber: rows.length + 1, kind: 'back', seats: seats.slice(-5) });
    }
    return rows;
  }

  const numbered = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => byNumber.get(from + index));
  const rows = [
    ...pairedSeatRows(numbered(1, 24), 1),
    { rowNumber: 7, kind: 'standard', left: numbered(25, 26), right: [] },
    { rowNumber: 8, kind: 'standard', left: numbered(27, 28), right: [] },
    ...pairedSeatRows(numbered(29, 48), 9),
    { rowNumber: 14, kind: 'back', seats: numbered(49, 53) },
  ];
  return extras.length ? [...rows, ...pairedSeatRows(extras, 15)] : rows;
}

function manifestStatusIndex(manifest) {
  const index = new Map();
  Object.values(manifest?.bookings || {}).forEach((booking) => {
    const bookingRef = normalizeBookingRef(booking?.id || booking?.bookingRef);
    const seats = Array.isArray(booking?.seatLabels)
      ? booking.seatLabels
      : Array.isArray(booking?.seatNumbers) ? booking.seatNumbers : [];
    if (!bookingRef) return;

    seats.forEach((seat, position) => {
      const seatLabel = normalizeSeatLabel(seat);
      if (!seatLabel || seatLabel === 'TBA') return;
      const perPassenger = Array.isArray(booking?.passengerStatus)
        ? booking.passengerStatus[position]
        : booking?.passengerStatus;
      index.set(manifestKey(bookingRef, seatLabel), perPassenger || booking?.status || '');
    });
  });
  return index;
}

function passengerManifestStatus(passenger, index) {
  return index.get(manifestKey(passenger?.bookingRef, passenger?.seatLabel)) || '';
}

function passengerDisplayState(passenger, manifestStatus) {
  if (passenger?.sourceState === 'OCCUPANT_CONFLICT') return DISPLAY_STATES.CONFLICT;
  if (['TOUR_PAX_ONLY_OCCUPIED', 'PAX_ONLY', 'UNSEATED_PAX'].includes(passenger?.sourceState)) {
    return DISPLAY_STATES.UNMATCHED;
  }
  const status = normalizeStatus(manifestStatus);
  if (['BOARDED', 'CHECKED_IN', 'CHECKEDIN'].includes(status)) return DISPLAY_STATES.BOARDED;
  if (['NO_SHOW', 'NOSHOW'].includes(status)) return DISPLAY_STATES.NO_SHOW;
  return DISPLAY_STATES.PENDING;
}

function seatState(seat, passenger, manifestStatus) {
  if (seat?.state === 'conflict' || passenger?.sourceState === 'OCCUPANT_CONFLICT') {
    return DISPLAY_STATES.CONFLICT;
  }
  if (seat?.state === 'unmatched'
    || ['TOUR_PAX_ONLY_OCCUPIED', 'PAX_ONLY', 'UNSEATED_PAX'].includes(passenger?.sourceState)) {
    return DISPLAY_STATES.UNMATCHED;
  }
  if (!passenger || ['empty', 'blocked'].includes(seat?.state)) return DISPLAY_STATES.EMPTY;
  return passengerDisplayState(passenger, manifestStatus);
}

function qualityIssues(pack) {
  const quality = pack?.quality || {};
  const issues = [];
  if (quality.pickupManifestPublishable !== true) {
    issues.push('Report pickup and passenger details are withheld by the reconciliation safety gate. Use the authoritative boarding manifest.');
  }
  if (quality.state !== 'complete') {
    issues.push('Pack is incomplete; check dispatch information before departure.');
  }
  if (Number(quality.conflicts) > 0) {
    issues.push(`${quality.conflicts} seat conflict${Number(quality.conflicts) === 1 ? '' : 's'}; the visual seat map is withheld.`);
  }
  if (Number(quality.tourPaxOnly) > 0) {
    issues.push(`${quality.tourPaxOnly} passenger${Number(quality.tourPaxOnly) === 1 ? '' : 's'} ha${Number(quality.tourPaxOnly) === 1 ? 's' : 've'} no pickup details.`);
  }
  if (Number(quality.paxOnly) > 0 || Number(quality.unseated) > 0) {
    issues.push('Some passengers have an unverified seat.');
  }
  if (Number(quality.missingReports) > 0) {
    issues.push('One or more source reports are unavailable.');
  }
  return issues;
}

function eventTimeMs(event) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(event?.dateISO || ''))) return NaN;
  const time = /^(\d{1,2}):(\d{2})/.exec(String(event?.time || '').trim());
  const hours = time ? Number(time[1]) : 23;
  const minutes = time ? Number(time[2]) : 59;
  if (hours > 23 || minutes > 59) return NaN;
  const value = new Date(`${event.dateISO}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`).getTime();
  return Number.isFinite(value) ? value : NaN;
}

function selectNextEvent(timeline, nowMs = Date.now()) {
  return timeline.find((event) => {
    const timestamp = eventTimeMs(event);
    return Number.isFinite(timestamp) && timestamp >= nowMs;
  }) || null;
}

function progressForPassengers(passengers) {
  return passengers.reduce((progress, passenger) => {
    if (passenger.displayState === DISPLAY_STATES.BOARDED) progress.boarded += 1;
    else if (passenger.displayState === DISPLAY_STATES.NO_SHOW) progress.noShow += 1;
    else if ([DISPLAY_STATES.UNMATCHED, DISPLAY_STATES.CONFLICT].includes(passenger.displayState)) progress.unresolved += 1;
    else progress.pending += 1;
    progress.total += 1;
    return progress;
  }, { total: 0, boarded: 0, pending: 0, noShow: 0, unresolved: 0 });
}

function commandCentreModel(pack, manifest, { nowMs = Date.now() } = {}) {
  const pickupManifestAvailable = pack?.quality?.pickupManifestPublishable === true;
  const index = manifestStatusIndex(manifest);
  const passengers = (pickupManifestAvailable ? selectOrderedPassengers(pack) : []).map((passenger) => {
    const manifestStatus = passengerManifestStatus(passenger, index);
    return {
      ...passenger,
      manifestStatus,
      displayState: passengerDisplayState(passenger, manifestStatus),
    };
  });
  const passengerByKey = new Map(passengers.map((passenger) => [passenger.passengerKey, passenger]));
  const seats = (pickupManifestAvailable ? selectOrderedSeats(pack) : []).map((seat) => {
    const passenger = passengerByKey.get(seat.passengerKey);
    return {
      ...seat,
      passenger,
      displayState: seatState(seat, passenger, passenger?.manifestStatus),
    };
  });
  const unresolved = new Set([
    ...passengers
      .filter((passenger) => passenger.sourceState !== 'MATCHED')
      .map((passenger) => passenger.passengerKey),
    ...seats
      .filter((seat) => [DISPLAY_STATES.UNMATCHED, DISPLAY_STATES.CONFLICT].includes(seat.displayState) && seat.passenger)
      .map((seat) => seat.passenger.passengerKey),
  ]).size;
  const pickups = (pickupManifestAvailable ? selectOrderedPickups(pack) : []).map((pickup) => {
    const pickupPassengers = passengers.filter((passenger) => passenger.pickupId === pickup.pickupId);
    return { pickup, passengers: pickupPassengers, progress: progressForPassengers(pickupPassengers) };
  });
  const unassignedPassengers = passengers.filter((passenger) => !passenger.pickupId);
  if (unassignedPassengers.length) {
    pickups.push({
      pickup: {
        pickupId: '__unassigned__',
        name: 'Pickup details unavailable',
        address: '',
        dateISO: pack?.dateISO || '',
        time: '',
        sequence: Number.MAX_SAFE_INTEGER,
        passengerCount: unassignedPassengers.length,
        bookingCount: new Set(unassignedPassengers.map((passenger) => passenger.bookingRef)).size,
      },
      passengers: unassignedPassengers,
      progress: progressForPassengers(unassignedPassengers),
    });
  }
  const timeline = selectOrderedTimeline(pack);
  return {
    pickupManifestAvailable,
    pickups,
    passengers,
    seats,
    seatRows: buildCoachSeatRows(seats),
    timeline,
    qualityIssues: qualityIssues(pack),
    unresolved,
    progress: progressForPassengers(passengers),
    nextEvent: selectNextEvent(timeline, nowMs),
  };
}

module.exports = {
  DISPLAY_STATES,
  manifestStatusIndex,
  passengerDisplayState,
  passengerManifestStatus,
  seatState,
  qualityIssues,
  selectNextEvent,
  progressForPassengers,
  buildCoachSeatRows,
  commandCentreModel,
};
