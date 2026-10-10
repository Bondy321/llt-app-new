const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');
const UNASSIGNED_SEATS = new Set(['', '0', 'S0', 'TBA', 'TBC', 'UNKNOWN', 'UNASSIGNED', 'N/A', '-']);

const normalizeManifestPassengerRows = (bookingData = {}) => {
  const details = Array.isArray(bookingData.passengerDetails) ? bookingData.passengerDetails : [];
  const names = Array.isArray(bookingData.passengerNames)
    ? bookingData.passengerNames
    : (Array.isArray(bookingData.passengers) ? bookingData.passengers : []);
  const seatNumbers = Array.isArray(bookingData.seatNumbers) ? bookingData.seatNumbers : [];
  const seatLabels = Array.isArray(bookingData.seatLabels) ? bookingData.seatLabels : [];
  const rowCount = Math.max(details.length, names.length, seatNumbers.length, seatLabels.length);
  const sourceIds = bookingData.sourceRoster?.state === 'active'
    && Array.isArray(bookingData.sourceRoster.passengerIds)
    && bookingData.sourceRoster.passengerIds.length === rowCount
    ? bookingData.sourceRoster.passengerIds : null;
  const strongIdentityRows = new Map();
  const rows = [];

  for (let index = 0; index < rowCount; index += 1) {
    const detail = details[index] && typeof details[index] === 'object' && !Array.isArray(details[index])
      ? details[index]
      : {};
    const name = toTrimmedString(detail.name) || toTrimmedString(names[index]) || 'Unknown Passenger';
    const rawSeatNumber = detail.seatNo ?? detail.seatNumber ?? seatNumbers[index] ?? null;
    const numericSeat = Number(rawSeatNumber);
    const hasNumericSeat = rawSeatNumber !== null
      && rawSeatNumber !== ''
      && Number.isInteger(numericSeat)
      && numericSeat > 0;
    const seatNumber = hasNumericSeat ? numericSeat : rawSeatNumber;
    const seatLabel = toTrimmedString(detail.seatLabel) || toTrimmedString(seatLabels[index]);
    const labelSeatMatch = seatLabel.match(/^S?0*(\d+)$/i);
    const assignedLabel = !UNASSIGNED_SEATS.has(seatLabel.toUpperCase());
    const seatIdentity = hasNumericSeat
      ? `number:${numericSeat}`
      : (labelSeatMatch && Number(labelSeatMatch[1]) > 0 ? `number:${Number(labelSeatMatch[1])}`
        : (assignedLabel ? `label:${seatLabel.toUpperCase()}` : null));
    const strongIdentity = sourceIds && /^srcpax_v1_[a-f0-9]{64}$/.test(sourceIds[index])
      ? `source:${sourceIds[index]}` : seatIdentity
      ? `${name.replace(/\s+/g, ' ').trim().toLowerCase()}|${seatIdentity}`
      : null;

    if (strongIdentity && strongIdentityRows.has(strongIdentity)) {
      rows[strongIdentityRows.get(strongIdentity)].sourceIndexes.push(index);
      continue;
    }
    if (strongIdentity) strongIdentityRows.set(strongIdentity, rows.length);

    rows.push({
      sourceIndex: index,
      sourceIndexes: [index],
      name,
      seatNumber,
      seatLabel,
      detail: details.length > 0 ? { ...detail, name } : null,
    });
  }

  return {
    rows,
    duplicateCount: Math.max(0, rowCount - rows.length),
  };
};

module.exports = { normalizeManifestPassengerRows };
