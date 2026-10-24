'use strict';

// The marker is a server Admin SDK auth override, not an ID-token custom claim.
// Normal Firebase users cannot set top-level auth members. A stale queued server
// write is rejected against CURRENT lease ownership at actual server commit.
const tourPublicationGate = () => [
  "auth != null && auth.lltTourPublisher === true && auth.tourCount >= 1 && auth.tourCount <= 16",
  ...Array.from({ length: 16 }, (_, index) => `(auth.tourCount <= ${index} || (root.child('sync_roster_control').child(auth.tour${index}).child('owner').val() === auth.owner && root.child('sync_roster_control').child(auth.tour${index}).child('leaseUntilMs').val() > now))`),
].join(' && ');

const scopedTour = expression => `(${Array.from({ length: 16 }, (_, index) =>
  `(auth.tourCount > ${index} && ${expression} === auth.tour${index})`).join(' || ')})`;

// Conditional REST PUT returns the competing value on an ETag mismatch, so
// Firebase requires read permission too. Limit this server-only capability to
// exact CAS leaves and the same currently owned component; never grant root reads.
const tourPublicationReadGrants = () => {
  const lease = tourPublicationGate();
  const existingTour = scopedTour("data.child('tourId').val()");
  const archiveTour = scopedTour("data.child('sourceSnapshot/tourId').val()");
  const sameJournalScope = Array.from({ length: 16 }, (_, index) =>
    `(auth.tourCount <= ${index} ? !data.child('tourIds/${index}').exists() : data.child('tourIds/${index}').val() === auth.tour${index})`).join(' && ');
  return [
    { path: ['tours', '$tourId'], predicate: `(${lease}) && ${scopedTour('$tourId')}` },
    { path: ['pickupPoints', '$tourId'], predicate: `(${lease}) && ${scopedTour('$tourId')}` },
    { path: ['bookings', '$bookingRef'], predicate: `(${lease}) && (!data.exists() || ${existingTour})` },
    { path: ['booking_identities', '$bookingRef'], predicate: `(${lease}) && ${scopedTour("root.child('bookings').child($bookingRef).child('tourId').val()")}` },
    { path: ['sync_roster_archive', '$bookingRef', '$archiveHash'], predicate: `(${lease}) && (!data.exists() || ${archiveTour})` },
    { path: ['sync_roster_control', '_transfers', '$transferId'], predicate: `(${lease}) && (!data.exists() || (!data.child('tourIds/16').exists() && ${sameJournalScope}))` },
  ];
};

const applyTourPublicationRules = document => {
  const rules = document.rules;
  if (!String(rules['.write']).includes('auth.lltTourPublisher')) {
    rules['.write'] = `(${rules['.write'] || false}) || (${tourPublicationGate()})`;
  }
  const visit = node => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '.validate' && !String(value).includes('auth.lltTourPublisher')) {
        node[key] = `(auth != null && auth.lltTourPublisher === true) || (${value})`;
      } else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(rules);
  for (const { path, predicate } of tourPublicationReadGrants()) {
    let node = rules;
    for (const part of path) node = (node[part] ||= {});
    if (!String(node['.read']).includes(predicate)) {
      node['.read'] = `(${node['.read'] || false}) || (${predicate})`;
    }
  }
  return document;
};
module.exports = { applyTourPublicationRules, tourPublicationGate, tourPublicationReadGrants };
