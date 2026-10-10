'use strict';

const SOURCE_PASSENGER_ID = /^srcpax_v1_[a-f0-9]{64}$/;
const ROSTER_REVISION = /^[a-f0-9]{64}$/;
const VALID_STATUSES = new Set(['PENDING', 'BOARDED', 'NO_SHOW', 'PARTIAL']);
const { validateContract } = require('../../contracts/generated/manifestRoster');

const rosterError = () => Object.assign(new Error('Passenger roster is unavailable; refresh after the import completes'), {
  code: 'SOURCE_ROSTER_INVALID',
});

const validateRosterStorageFields = (roster, count) => {
  if (roster.passengerIndexes !== undefined && (!Array.isArray(roster.passengerIndexes)
    || roster.passengerIndexes.length !== count
    || roster.passengerIndexes.some((index, position) => index !== String(position)))) throw rosterError();
  for (const [value, expected] of [[roster.passengerCount,count],
    [roster.passengerIdsJson,JSON.stringify(roster.passengerIds)]]) {
    if (value !== undefined && value !== expected) throw rosterError();
  }
};

const readSourceRoster = (booking = {}) => {
  if (booking.sourceRoster === undefined || booking.sourceRoster === null) return null;
  const roster = booking.sourceRoster;
  if (roster.schemaVersion !== 1 || !['active', 'not_in_report'].includes(roster.state)
    || !ROSTER_REVISION.test(roster.revision || '')) throw rosterError();
  if (roster.state === 'not_in_report') return roster;
  const count = Array.isArray(booking.passengerDetails) ? booking.passengerDetails.length : 0;
  if (!validateContract('ManifestRosterIdentity', {rosterRevision:roster.revision,passengerIds:roster.passengerIds}).valid
    || count < 1 || roster.passengerIds.length !== count) throw rosterError();
  validateRosterStorageFields(roster, count);
  return roster;
};

const decodeStoredBoarding = (live) => {
  if (live.passengerIdsJson === undefined && live.passengerStatusCodes === undefined) return null;
  try {
    if (typeof live.passengerIdsJson !== 'string' || live.passengerIdsJson.length > 20000
      || typeof live.passengerStatusCodes !== 'string' || !/^[PBNR]+$/.test(live.passengerStatusCodes)) return {invalid:true};
    const ids = JSON.parse(live.passengerIdsJson);
    if (!validateContract('ManifestRosterIdentity',{rosterRevision:live.rosterRevision,passengerIds:ids}).valid
      || ids.length !== live.passengerStatusCodes.length) return {invalid:true};
    const meanings = {P:'PENDING',B:'BOARDED',N:'NO_SHOW',R:'PARTIAL'};
    return {ids,statuses:[...live.passengerStatusCodes].map(code=>meanings[code])};
  } catch { return {invalid:true}; }
};

const resolveSourcePassengerStatuses = (roster, live = {}) => {
  const currentIds = roster.passengerIds;
  const encoded = decodeStoredBoarding(live);
  if (encoded?.invalid) return {statuses:currentIds.map(()=>'PENDING'),needsReview:true};
  const priorIds = encoded?.ids;
  const priorStatuses = encoded ? encoded.statuses : Array.isArray(live.passengerStatus) ? live.passengerStatus : [];
  const validPriorIds = encoded && Array.isArray(priorIds) && priorIds.length === priorStatuses.length
    && priorIds.every(id => typeof id === 'string' && SOURCE_PASSENGER_ID.test(id))
    && new Set(priorIds).size === priorIds.length;
  if (validPriorIds) {
    const byId = new Map(priorIds.map((id, index) => [id, priorStatuses[index]]));
    const current = new Set(currentIds);
    return { statuses: currentIds.map(id => VALID_STATUSES.has(byId.get(id)) ? byId.get(id) : 'PENDING'),
      needsReview: roster.reviewRequired === true
        && priorIds.some((id, index) => !current.has(id) && priorStatuses[index] !== 'PENDING') };
  }
  // Legacy status positions came from a deduplicated presentation, whereas the
  // archived source positions describe raw rows. Even equal lengths cannot prove
  // their ordering. Preserve the private archive for review; never guess identity.
  const needsReview = priorStatuses.some(status => VALID_STATUSES.has(status) && status !== 'PENDING')
    || (VALID_STATUSES.has(live.status) && live.status !== 'PENDING');
  return { statuses: currentIds.map(() => 'PENDING'), needsReview };
};

module.exports = { readSourceRoster, resolveSourcePassengerStatuses };
