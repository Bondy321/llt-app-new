// Client-safe mirror of the Driver Tour Pack v1 contract. It intentionally has
// no Node crypto dependency: the ingestion boundary has already recomputed the
// fingerprint; mobile validates the complete, allowlisted document before use.
const { normalizeTourId } = require('./tourIdentityService');

const DRIVER_TOUR_PACK_SCHEMA_VERSION = 1;
const DRIVER_TOUR_PACK_READABLE_SCHEMA_VERSIONS = Object.freeze([1]);
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const FORBIDDEN = /(?:^|_)(?:email|sales?|profit|margin|price|gmail|message_id|attachment_id|raw_metadata|internal_notes?)(?:_|$)/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const TOP = ['schemaVersion','departureKey','tourId','tourCode','dateISO','status','sourceSnapshotDate','generatedAtMs','publishedAtMs','revision','contentFingerprint','expiresAtMs','coverage','quality','tour','pickups','passengers','seats','timeline','hotels','services','coach','contacts','itineraries'];
const COVERAGE = ['tourSummary','paxByDepPoint','tourPax','tourContract','hotelInfo','tourItinerary'];
const QUALITY = ['state','matched','tourPaxOnly','paxOnly','conflicts','duplicateTourPaxSeats','duplicatePaxSeats','unseated','layoutAnomalies','missingReports','suppressSeatMap','pickupManifestPublishable'];
const safeKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 180 && !/[.#$/\[\]\x00-\x1f\x7f]/.test(v);
const object = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const realDate = (v) => { if (!DATE.test(String(v || ''))) return false; const [y,m,d] = v.split('-').map(Number); const x = new Date(Date.UTC(y,m-1,d)); return x.getUTCFullYear() === y && x.getUTCMonth() === m-1 && x.getUTCDate() === d; };
const errorsForExact = (value, keys, path, errors) => { if (!object(value)) { errors.push(`${path} must be an object`); return false; } const allowed = new Set(keys); Object.keys(value).forEach((k) => { if (!allowed.has(k)) errors.push(`${path}.${k} is unknown`); }); keys.forEach((k) => { if (!Object.hasOwn(value,k)) errors.push(`${path}.${k} is required`); }); return true; };
const string = (value, path, errors, { required = false, max = 240 } = {}) => { if (typeof value !== 'string') errors.push(`${path} must be a string`); else if ((required && !value.trim()) || value.length > max) errors.push(`${path} is invalid`); };
const integer = (value, path, errors, positive = false) => { if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) errors.push(`${path} must be a ${positive ? 'positive' : 'non-negative'} integer`); };
const record = (value, limit, path, errors, validator) => { if (!object(value)) { errors.push(`${path} must be an object`); return; } const entries = Object.entries(value); if (entries.length > limit) errors.push(`${path} exceeds limit`); entries.forEach(([key,item]) => { if (!safeKey(key)) errors.push(`${path} contains unsafe key`); validator(item,key,`${path}.${key}`,errors); }); };
const privacy = (value, path, errors) => { if (typeof value === 'string') { if (EMAIL.test(value)) errors.push(`${path} contains email`); return; } if (Array.isArray(value)) return value.forEach((x,i) => privacy(x,`${path}[${i}]`,errors)); if (object(value)) Object.entries(value).forEach(([k,v]) => { if (FORBIDDEN.test(k)) errors.push(`${path}.${k} is prohibited`); privacy(v,`${path}.${k}`,errors); }); };

function rehydrateDriverTourPackFromFirebase(value) {
  if (!object(value)) return value;
  const pack = { ...value };
  ['pickups','passengers','seats','timeline','hotels','services'].forEach((field) => {
    if (!Object.hasOwn(pack, field)) pack[field] = {};
  });
  if (object(pack.coach) && !Object.hasOwn(pack.coach, 'details')) pack.coach = { ...pack.coach, details: {} };
  if (!Object.hasOwn(pack, 'contacts')) {
    pack.contacts = { bookingLeads: {}, operational: {} };
  } else if (object(pack.contacts)) {
    pack.contacts = { ...pack.contacts };
    if (!Object.hasOwn(pack.contacts, 'bookingLeads')) pack.contacts.bookingLeads = {};
    if (!Object.hasOwn(pack.contacts, 'operational')) pack.contacts.operational = {};
  }
  return pack;
}

function validateDriverTourPack(pack) {
  const errors = [];
  if (!errorsForExact(pack, TOP, '$', errors)) return { valid: false, errors };
  if (pack.schemaVersion !== DRIVER_TOUR_PACK_SCHEMA_VERSION) errors.push('$.schemaVersion is unreadable');
  if (!safeKey(pack.departureKey) || !safeKey(pack.tourId)) errors.push('identity key invalid');
  string(pack.tourCode, '$.tourCode', errors, { required: true, max: 100 });
  if (!realDate(pack.dateISO) || !realDate(pack.sourceSnapshotDate)) errors.push('date invalid');
  if (`${pack.dateISO}::${normalizeTourId(pack.tourId)}` !== pack.departureKey) errors.push('departure identity mismatch');
  if (!['active','cancelled','withdrawn'].includes(pack.status)) errors.push('status invalid');
  ['generatedAtMs','publishedAtMs','expiresAtMs'].forEach((k) => integer(pack[k], `$.${k}`, errors));
  integer(pack.revision, '$.revision', errors, true);
  if (!SHA.test(pack.contentFingerprint || '')) errors.push('fingerprint invalid');
  if (errorsForExact(pack.coverage, COVERAGE, '$.coverage', errors)) COVERAGE.forEach((k) => { if (typeof pack.coverage[k] !== 'boolean') errors.push(`$.coverage.${k} invalid`); });
  if (errorsForExact(pack.quality, QUALITY, '$.quality', errors)) { if (!['complete','degraded'].includes(pack.quality.state)) errors.push('$.quality.state invalid'); QUALITY.filter((k) => !['state','suppressSeatMap','pickupManifestPublishable'].includes(k)).forEach((k) => integer(pack.quality[k], `$.quality.${k}`, errors)); ['suppressSeatMap','pickupManifestPublishable'].forEach((k) => { if (typeof pack.quality[k] !== 'boolean') errors.push(`$.quality.${k} invalid`); }); }
  validateTour(pack.tour, pack.status, errors);
  record(pack.pickups,60,'$.pickups',errors,validatePickup); record(pack.passengers,100,'$.passengers',errors,validatePassenger); record(pack.seats,120,'$.seats',errors,validateSeat); record(pack.timeline,250,'$.timeline',errors,validateTimeline); record(pack.hotels,30,'$.hotels',errors,validateHotel); record(pack.services,150,'$.services',errors,validateService);
  validateCoach(pack.coach, errors); validateContacts(pack.contacts, errors); validateItineraries(pack.itineraries, errors); validateRelationships(pack, errors);
  if (pack.status !== 'active') {
    ['pickups','passengers','seats','timeline','hotels','services'].forEach((k) => { if (object(pack[k]) && Object.keys(pack[k]).length) errors.push(`$.${k} must be empty for tombstone`); });
    if (object(pack.tour) && ['name','destination','routeCode'].some((k) => pack.tour[k] !== '')) errors.push('$.tour operational text must be empty for tombstone');
    if (object(pack.coach) && (pack.coach.seatMapAvailable !== false || pack.coach.layoutSeatCount !== 0 || (object(pack.coach.details) && Object.keys(pack.coach.details).length))) errors.push('$.coach must contain no operational data for tombstone');
    if (object(pack.contacts) && ((object(pack.contacts.bookingLeads) && Object.keys(pack.contacts.bookingLeads).length) || (object(pack.contacts.operational) && Object.keys(pack.contacts.operational).length))) errors.push('$.contacts must be empty for tombstone');
    if (object(pack.itineraries) && ['client','driver'].some((k) => object(pack.itineraries[k]) && (pack.itineraries[k].title !== '' || pack.itineraries[k].text !== ''))) errors.push('$.itineraries must contain no operational text for tombstone');
  }
  privacy(pack, '$', errors);
  return { valid: errors.length === 0, errors };
}
function validateTour(v,status,e) { const k=['name','destination','routeCode','endDateISO','days','status']; if (errorsForExact(v,k,'$.tour',e)) { ['name','destination','routeCode'].forEach(x=>string(v[x],`$.tour.${x}`,e,{required:status==='active'&&x==='name',max:300})); if(!realDate(v.endDateISO))e.push('$.tour.endDateISO invalid'); integer(v.days,'$.tour.days',e,true); if(v.status!==status)e.push('$.tour.status mismatch'); } }
function validatePickup(v,key,p,e){const k=['pickupId','dateISO','time','name','address','passengerCount','bookingCount','sequence'];if(errorsForExact(v,k,p,e)){if(v.pickupId!==key)e.push(`${p}.pickupId mismatch`);if(!realDate(v.dateISO))e.push(`${p}.date invalid`);['time','name','address'].forEach(x=>string(v[x],`${p}.${x}`,e,{required:x==='name',max:x==='address'?600:300}));['passengerCount','bookingCount','sequence'].forEach(x=>integer(v[x],`${p}.${x}`,e));}}
function validatePassenger(v,key,p,e){const k=['passengerKey','name','bookingRef','seatLabel','pickupId','bookingLeadContactId','sourceState','note'];if(errorsForExact(v,k,p,e)){if(v.passengerKey!==key)e.push(`${p}.key mismatch`);['name','bookingRef','seatLabel','pickupId','bookingLeadContactId','note'].forEach(x=>string(v[x],`${p}.${x}`,e,{required:x==='name',max:300}));if(!['MATCHED','TOUR_PAX_ONLY_OCCUPIED','PAX_ONLY','OCCUPANT_CONFLICT','UNSEATED_PAX'].includes(v.sourceState))e.push(`${p}.sourceState invalid`);}}
function validateSeat(v,key,p,e){const k=['seatId','label','state','passengerKey'];if(errorsForExact(v,k,p,e)){if(v.seatId!==key)e.push(`${p}.key mismatch`);string(v.label,`${p}.label`,e,{required:true,max:40});string(v.passengerKey,`${p}.passengerKey`,e,{max:80});if(!['empty','occupied','unmatched','blocked','conflict'].includes(v.state))e.push(`${p}.state invalid`);}}
function validateTimeline(v,key,p,e){const k=['eventId','type','dateISO','time','title','subtitle','reference','notes','sequence'];if(errorsForExact(v,k,p,e)){if(v.eventId!==key)e.push(`${p}.key mismatch`);if(!['pickup','hotel','service','coach'].includes(v.type))e.push(`${p}.type invalid`);if(!realDate(v.dateISO))e.push(`${p}.date invalid`);['time','title','subtitle','reference','notes'].forEach(x=>string(v[x],`${p}.${x}`,e,{required:x==='title',max:x==='notes'?2000:600}));integer(v.sequence,`${p}.sequence`,e);}}
function validateHotel(v,key,p,e){const k=['hotelId','name','address','postcode','phone','nights','boardBasis','isPlaceholder','arrivalDateISO'];if(errorsForExact(v,k,p,e)){if(v.hotelId!==key)e.push(`${p}.key mismatch`);['name','address','postcode','phone','nights','boardBasis'].forEach(x=>string(v[x],`${p}.${x}`,e,{required:x==='name',max:800}));if(typeof v.isPlaceholder!=='boolean'||!realDate(v.arrivalDateISO))e.push(`${p} invalid`);}}
function validateService(v,key,p,e){const k=['serviceId','type','description','supplier','dateISO','time','bookingRef','notes','quantity'];if(errorsForExact(v,k,p,e)){if(v.serviceId!==key)e.push(`${p}.key mismatch`);['type','description','supplier','time','bookingRef','notes'].forEach(x=>string(v[x],`${p}.${x}`,e,{required:x==='description',max:2000}));if(!realDate(v.dateISO)||typeof v.quantity!=='number'||!Number.isFinite(v.quantity)||v.quantity<0)e.push(`${p} invalid`);}}
function validateCoach(v,e){if(errorsForExact(v,['seatMapAvailable','layoutSeatCount','details'],'$.coach',e)){if(typeof v.seatMapAvailable!=='boolean')e.push('$.coach.seatMapAvailable invalid');integer(v.layoutSeatCount,'$.coach.layoutSeatCount',e);record(v.details,20,'$.coach.details',e,(x,k,p,er)=>{if(errorsForExact(x,['coachDetailId','company','driverName','phone','notes'],p,er)){if(x.coachDetailId!==k)er.push(`${p}.key mismatch`);['company','driverName','phone','notes'].forEach(n=>string(x[n],`${p}.${n}`,er,{max:2000}));}});}}
function validateContacts(v,e){if(!errorsForExact(v,['bookingLeads','operational'], '$.contacts',e))return;record(v.bookingLeads,100,'$.contacts.bookingLeads',e,(x,k,p,er)=>{if(errorsForExact(x,['contactId','bookingRef','phone'],p,er)){if(x.contactId!==k)er.push(`${p}.key mismatch`);string(x.bookingRef,`${p}.bookingRef`,er,{required:true,max:100});string(x.phone,`${p}.phone`,er,{required:true,max:80});}});record(v.operational,100,'$.contacts.operational',e,(x,k,p,er)=>{if(errorsForExact(x,['contactId','type','name','phone','reference'],p,er)){if(x.contactId!==k)er.push(`${p}.key mismatch`);if(!['hotel','coach','supplier'].includes(x.type))er.push(`${p}.type invalid`);['name','phone','reference'].forEach(n=>string(x[n],`${p}.${n}`,er,{required:n==='name',max:300}));}});}
function validateItineraries(v,e){if(errorsForExact(v,['client','driver'],'$.itineraries',e))['client','driver'].forEach(k=>{if(errorsForExact(v[k],['title','text'],`$.itineraries.${k}`,e)){string(v[k].title,`$.itineraries.${k}.title`,e,{max:300});string(v[k].text,`$.itineraries.${k}.text`,e,{max:24000});}});}
function validateRelationships(p,e){if(![p.pickups,p.passengers,p.seats,p.coach,p.contacts].every(object))return;const counts={};const refs={};Object.entries(p.passengers).forEach(([key,x])=>{if(x.pickupId){if(!p.pickups[x.pickupId])e.push(`${key} unknown pickup`);counts[x.pickupId]=(counts[x.pickupId]||0)+1;(refs[x.pickupId] ||= new Set()).add(x.bookingRef);}if(x.bookingLeadContactId&&p.contacts.bookingLeads?.[x.bookingLeadContactId]?.bookingRef!==x.bookingRef)e.push(`${key} invalid booking lead`);});Object.entries(p.pickups).forEach(([key,x])=>{if(x.passengerCount!==(counts[key]||0)||x.bookingCount!==(refs[key]?.size||0))e.push(`${key} pickup totals mismatch`);});Object.entries(p.seats).forEach(([key,x])=>{const pax=x.passengerKey?p.passengers[x.passengerKey]:null;if(x.passengerKey&&!pax)e.push(`${key} unknown passenger`);if(pax&&pax.seatLabel!==x.label)e.push(`${key} seat mismatch`);if(['empty','blocked'].includes(x.state)&&x.passengerKey)e.push(`${key} forbidden passenger`);});if(p.coach.layoutSeatCount!==Object.keys(p.seats).length)e.push('seat count mismatch');if((p.coach.seatMapAvailable===false&&Object.keys(p.seats).length)||(p.coach.seatMapAvailable===true&&p.quality?.suppressSeatMap))e.push('seat map availability mismatch');}

module.exports = { DRIVER_TOUR_PACK_SCHEMA_VERSION, DRIVER_TOUR_PACK_READABLE_SCHEMA_VERSIONS, rehydrateDriverTourPackFromFirebase, validateDriverTourPack };
