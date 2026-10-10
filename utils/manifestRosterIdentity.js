const ROSTER_REFRESH_MESSAGE = 'The passenger roster or your tour access has changed. Refresh the manifest before recording boarding statuses.';
const { validateContract } = require('../src/shared/contracts/generated/manifestRoster');

const manifestRosterIdentity = (value = {}, passengerCount) => {
  if (value.passengerIds === undefined && value.rosterRevision === undefined) return {};
  if (!validateContract('ManifestRosterIdentity', {rosterRevision:value.rosterRevision,passengerIds:value.passengerIds}).valid
    || typeof value.rosterRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.rosterRevision)
    || !Array.isArray(value.passengerIds) || value.passengerIds.length !== passengerCount
    || value.passengerIds.some(id => typeof id !== 'string' || !/^srcpax_v1_[a-f0-9]{64}$/.test(id))
    || new Set(value.passengerIds).size !== passengerCount) {
    const error = new Error('Passenger roster identity is invalid. Refresh the manifest before recording boarding statuses.');
    error.code = 'ROSTER_REFRESH_REQUIRED';
    error.retryable = false;
    throw error;
  }
  return { passengerIds: [...value.passengerIds], rosterRevision: value.rosterRevision };
};

module.exports = { manifestRosterIdentity, ROSTER_REFRESH_MESSAGE };
