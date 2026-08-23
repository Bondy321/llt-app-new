const { normalizeTourId } = require('../services/tourIdentityService');

const normalizeBookingReference = (value) => String(value || '').trim().toUpperCase();

const toTelephoneUrl = (phone) => {
  const dialablePhone = String(phone || '').trim().replace(/[^0-9+*#,;]/g, '');
  return dialablePhone ? `tel:${dialablePhone}` : null;
};

const buildBookingLeadPhoneIndex = (pack, tourId) => {
  const packTourId = normalizeTourId(pack?.tourId);
  const requestedTourId = normalizeTourId(tourId);
  if (
    !pack
    || !packTourId
    || packTourId !== requestedTourId
    || !pack.contacts?.bookingLeads
  ) {
    return new Map();
  }

  const phoneByBookingReference = new Map();
  Object.values(pack.contacts.bookingLeads).forEach((contact) => {
    const bookingReference = normalizeBookingReference(contact?.bookingRef);
    const telephoneUrl = toTelephoneUrl(contact?.phone);
    if (bookingReference && telephoneUrl && !phoneByBookingReference.has(bookingReference)) {
      phoneByBookingReference.set(bookingReference, contact.phone);
    }
  });
  return phoneByBookingReference;
};

module.exports = {
  buildBookingLeadPhoneIndex,
  normalizeBookingReference,
  toTelephoneUrl,
};
