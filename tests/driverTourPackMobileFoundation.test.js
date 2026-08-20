const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validateDriverTourPack } = require('../services/driverTourPackSchema');
const { getDriverTourPackFreshness } = require('../services/driverTourPackFreshness');
const { createDriverTourPackService, resolveExactDepartureKey, validateDriverTourPackAssignment } = require('../services/driverTourPackService');
const { selectOrderedPickups, selectPassengersByPickup, selectOrderedSeats, selectOrderedTimeline } = require('../services/driverTourPackSelectors');

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};
const content = (pack) => ({ schemaVersion:pack.schemaVersion,departureKey:pack.departureKey,tourId:pack.tourId,tourCode:pack.tourCode,dateISO:pack.dateISO,status:pack.status,expiresAtMs:pack.expiresAtMs,coverage:pack.coverage,quality:pack.quality,tour:pack.tour,pickups:pack.pickups,passengers:pack.passengers,seats:pack.seats,timeline:pack.timeline,hotels:pack.hotels,services:pack.services,coach:pack.coach,contacts:pack.contacts,itineraries:pack.itineraries });
function pack(overrides = {}) {
  const value={schemaVersion:1,departureKey:'2026-09-10::5001D_1',tourId:'5001D_1',tourCode:'5001D 1',dateISO:'2026-09-10',status:'active',sourceSnapshotDate:'2026-08-20',generatedAtMs:1787227200000,publishedAtMs:1787227200000,revision:1,contentFingerprint:'',expiresAtMs:1893456000000,coverage:{tourSummary:true,paxByDepPoint:true,tourPax:true,tourContract:true,hotelInfo:true,tourItinerary:true},quality:{state:'complete',matched:1,tourPaxOnly:0,paxOnly:0,conflicts:0,duplicateTourPaxSeats:0,duplicatePaxSeats:0,unseated:0,layoutAnomalies:0,missingReports:0,suppressSeatMap:false,pickupManifestPublishable:true},tour:{name:'Tour',destination:'Tour',routeCode:'WEST',endDateISO:'2026-09-10',days:1,status:'active'},pickups:{p1:{pickupId:'p1',dateISO:'2026-09-10',time:'08:00',name:'Stop',address:'Road',passengerCount:1,bookingCount:1,sequence:0}},passengers:{passenger_1:{passengerKey:'passenger_1',name:'Jane',bookingRef:'BR1',seatLabel:'1',pickupId:'p1',bookingLeadContactId:'lead_1',sourceState:'MATCHED',note:''}},seats:{seat_1:{seatId:'seat_1',label:'1',state:'occupied',passengerKey:'passenger_1'}},timeline:{},hotels:{},services:{},coach:{seatMapAvailable:true,layoutSeatCount:1,details:{}},contacts:{bookingLeads:{lead_1:{contactId:'lead_1',bookingRef:'BR1',phone:'07123'}},operational:{}},itineraries:{client:{title:'',text:''},driver:{title:'',text:'Driver instructions'}}};
  Object.assign(value,overrides); value.contentFingerprint=`sha256:${createHash('sha256').update(JSON.stringify(canonical(content(value)))).digest('hex')}`; return value;
}
function tombstonePack(status = 'withdrawn', overrides = {}) {
  return pack({
    status,
    pickups: {}, passengers: {}, seats: {}, timeline: {}, hotels: {}, services: {},
    tour: { name: '', destination: '', routeCode: '', endDateISO: '2026-09-10', days: 1, status },
    coach: { seatMapAvailable: false, layoutSeatCount: 0, details: {} },
    contacts: { bookingLeads: {}, operational: {} },
    itineraries: { client: { title: '', text: '' }, driver: { title: '', text: '' } },
    ...overrides,
  });
}
function memory() { const data=new Map(); return { data, getItemAsync:async(k)=>data.get(k)||null,setItemAsync:async(k,v)=>data.set(k,v),deleteItemAsync:async(k)=>data.delete(k) }; }
function fakeDb(initial) { const listeners=[]; const packRef={ value:initial, once:async()=>({val:()=>packRef.value}) }; return { ref(path) { if(path.endsWith('/revision')) return { on:(_e,fn)=>listeners.push(fn),off:(_e,fn)=>{const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);} }; return packRef; }, emit(revision){listeners.forEach((fn)=>fn({val:()=>revision}));}, packRef }; }
const scope={authUid:'auth-one',driverId:'D-1',departureKey:'2026-09-10::5001D_1'};

test('client schema validates a complete v1 pack and rejects privacy/relationship changes', () => {
  assert.equal(validateDriverTourPack(pack()).valid,true);
  const invalid=pack(); invalid.passengers.passenger_1.email='no@example.com';
  assert.equal(validateDriverTourPack(invalid).valid,false);
  invalid.passengers.passenger_1.email=undefined; delete invalid.passengers.passenger_1.email; invalid.seats.seat_1.passengerKey='missing';
  assert.equal(validateDriverTourPack(invalid).valid,false);
});

test('client rejects a cancelled pack that retains operational text', () => {
  const tombstone = tombstonePack('cancelled', {
    itineraries: { client: { title: '', text: '' }, driver: { title: '', text: 'private instruction' } },
  });
  assert.equal(validateDriverTourPack(tombstone).valid, false);
});
test('exact departure identity uses explicit canonical keys or strict date plus normalized tour id', () => {
  assert.deepEqual(resolveExactDepartureKey({tourId:'5001d 1',startDate:'10/09/2026'}),{ok:true,departureKey:'2026-09-10::5001D_1',tourId:'5001D_1',dateISO:'2026-09-10',source:'derived'});
  assert.equal(resolveExactDepartureKey({tourId:'5001D 1'}).ok,false);
  assert.equal(resolveExactDepartureKey({departureKey:'2026-09-10::5001D_1',tourId:'wrong'}).ok,false);
  assert.equal(resolveExactDepartureKey({tourId:'5001D 1',startDate:'31/02/2026'}).ok,false);
});
test('identity-scoped replacement cache preserves a valid cache when remote payload is malformed', async () => {
  const store=memory(); const db=fakeDb(pack()); const service=createDriverTourPackService({storage:store,db,now:()=>1787227200000});
  assert.equal((await service.fetchRemote(scope)).success,true);
  db.packRef.value={bad:true}; const failed=await service.fetchRemote(scope); assert.equal(failed.success,false);
  const cached=await service.load(scope); assert.equal(cached.success,true); assert.equal(cached.data.pack.revision,1);
  const other=await service.load({...scope,authUid:'auth-two'}); assert.equal(other.data,null);
  assert.equal((await service.purge(scope)).success,true); assert.equal((await service.purge(scope)).success,true);
});
test('expired and withdrawn source packs clear cached PII while retaining a safe state', async () => {
  const store=memory(); const db=fakeDb(pack()); const service=createDriverTourPackService({storage:store,db,now:()=>1787227200000});
  await service.fetchRemote(scope); db.packRef.value=tombstonePack();
  const tombstoneValidation = validateDriverTourPack(db.packRef.value);
  assert.equal(tombstoneValidation.valid, true, tombstoneValidation.errors.join('\n'));
  const remote=await service.fetchRemote(scope); assert.equal(remote.success,true); assert.equal(remote.data.freshness.state,'withdrawn'); assert.equal(remote.data.pack,null); assert.equal((await service.load(scope)).data,null);
});
test('malformed cached entries are deleted fail-closed', async () => {
  const store=memory(); const service=createDriverTourPackService({storage:store});
  await store.setItemAsync(service.cacheKey(scope),JSON.stringify({pack:{unsafe:true}}));
  const result=await service.load(scope); assert.equal(result.success,false); assert.equal(store.data.size,0);
});
test('revision subscription is bounded to exact pack and assignment validation is fail-closed', async () => {
  const db=fakeDb(pack()); const service=createDriverTourPackService({storage:memory(),db}); let revision=null; const stop=service.subscribeRevision(scope,(event)=>{revision=event.revision;}); db.emit(2); stop(); db.emit(3); assert.equal(revision,2);
  assert.equal(validateDriverTourPackAssignment({authUid:'uid',driverId:'D-1',driverAuthUid:'uid',assignedDepartureKey:scope.departureKey,manifestAssigned:true,pack:pack()}).valid,true);
  assert.equal(validateDriverTourPackAssignment({authUid:'uid',driverId:'D-1',driverAuthUid:'other',assignedDepartureKey:scope.departureKey,manifestAssigned:true,pack:pack()}).valid,false);
});
test('freshness distinguishes missing, stale, incomplete, expiry and withdrawal', () => {
  const now=1787227200000; assert.equal(getDriverTourPackFreshness(null,{now}).state,'missing'); assert.equal(getDriverTourPackFreshness(pack({generatedAtMs:now-3*86400000}),{now}).state,'stale'); assert.equal(getDriverTourPackFreshness(pack({quality:{...pack().quality,state:'degraded'}}),{now}).state,'incomplete'); assert.equal(getDriverTourPackFreshness(pack({expiresAtMs:now}),{now}).state,'expired'); assert.equal(getDriverTourPackFreshness(pack({status:'withdrawn',pickups:{},passengers:{},seats:{},timeline:{},hotels:{},services:{},coach:{seatMapAvailable:false,layoutSeatCount:0,details:{}}}),{now}).state,'withdrawn');
  assert.equal(getDriverTourPackFreshness(pack({generatedAtMs:'1787227200000'}),{now}).state,'stale');
});
test('pure selectors order operational data deterministically without mutating packs', () => {
  const value=pack(); value.pickups={later:{...value.pickups.p1,pickupId:'later',time:'09:00',sequence:2,passengerCount:0,bookingCount:0},first:{...value.pickups.p1,pickupId:'first',time:'08:00',sequence:1}}; value.passengers.passenger_1.pickupId='first'; value.timeline={z:{eventId:'z',type:'coach',dateISO:'2026-09-10',time:'10:00',title:'Z',subtitle:'',reference:'',notes:'',sequence:2},a:{eventId:'a',type:'pickup',dateISO:'2026-09-10',time:'08:00',title:'A',subtitle:'',reference:'',notes:'',sequence:1}};
  assert.deepEqual(selectOrderedPickups(value).map(x=>x.pickupId),['first','later']); assert.equal(selectPassengersByPickup(value)[0].passengers[0].passengerKey,'passenger_1'); assert.deepEqual(selectOrderedSeats(value).map(x=>x.label),['1']); assert.deepEqual(selectOrderedTimeline(value).map(x=>x.eventId),['a','z']);
});
