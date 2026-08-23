const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBookingLeadPhoneIndex,
  normalizeBookingReference,
  toTelephoneUrl,
} = require('../utils/bookingLeadPhone');

test('booking lead phone helpers normalize references and create safe telephone URLs', () => {
  assert.equal(normalizeBookingReference(' ref-100 '), 'REF-100');
  assert.equal(toTelephoneUrl('+44 (0) 7700 900-123'), 'tel:+4407700900123');
  assert.equal(toTelephoneUrl(''), null);
});

test('booking lead phone index is booking-scoped and rejects a stale Tour Pack', () => {
  const pack = {
    tourId: 'TOUR-1',
    contacts: {
      bookingLeads: {
        lead_1: { contactId: 'lead_1', bookingRef: ' ref-100 ', phone: '07123 456789' },
      },
    },
  };

  const activeIndex = buildBookingLeadPhoneIndex(pack, ' tour-1 ');
  assert.equal(activeIndex.get('REF-100'), '07123 456789');
  assert.equal(buildBookingLeadPhoneIndex(pack, 'TOUR-2').size, 0);
  assert.equal(buildBookingLeadPhoneIndex({ ...pack, tourId: '' }, '').size, 0);
});
