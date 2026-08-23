const { parseSupportedStartDate } = require('../services/itineraryDateParser');
const { buildDestinationQuery } = require('./directions');

const formatPickupDate = (value) => {
  const parsed = parseSupportedStartDate(value);
  if (!parsed) return '';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
};

const resolvePrimaryPickup = (bookingData = {}) => {
  const pickup = Array.isArray(bookingData.pickupPoints) && bookingData.pickupPoints.length
    ? bookingData.pickupPoints[0]
    : {};
  const date = pickup.date || pickup.pickupDate || bookingData.pickupDate || '';
  const time = pickup.time || pickup.pickupTime || bookingData.pickupTime || '';
  const location = pickup.location || pickup.pickupLocation || bookingData.pickupLocation || '';
  const address = pickup.address || pickup.pickupAddress || bookingData.pickupAddress || '';
  return {
    date,
    formattedDate: formatPickupDate(date),
    time,
    location,
    address,
    destination: buildDestinationQuery(location, address),
  };
};

module.exports = {
  formatPickupDate,
  resolvePrimaryPickup,
};
