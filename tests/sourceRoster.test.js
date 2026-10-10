'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readSourceRoster, resolveSourcePassengerStatuses } = require('../functions/src/domains/manifests/sourceRoster');
const { normalizeManifestPassengerRows } = require('../functions/lib/manifestPassengers');
const { buildTourManifestPayload } = require('../functions/src/domains/manifests/manifestDomain');
const id = char => `srcpax_v1_${char.repeat(64)}`;
const revision = 'a'.repeat(64);
const roster = (ids, extra = {}) => ({schemaVersion:1,state:'active',revision,passengerIds:ids,...extra});

test('source roster IDs preserve identical named/seated passenger occurrences', () => {
  const booking = {passengerDetails:[{name:'Passenger A',seatNo:0},{name:'Passenger A',seatNo:0}],
    sourceRoster:roster([id('a'),id('b')])};
  assert.equal(readSourceRoster(booking).passengerIds.length, 2);
  assert.equal(normalizeManifestPassengerRows(booking).rows.length, 2);
  assert.equal(normalizeManifestPassengerRows(booking).duplicateCount, 0);
});
test('unassigned manual party members remain distinct while assigned legacy duplicates still reconcile', () => {
  for (const seat of [0,'TBA','TBC','N/A','-']) {
    const result=normalizeManifestPassengerRows({passengerNames:['Same Name','Same Name'],
      seatNumbers:[seat,seat],seatLabels:[String(seat),String(seat)]});
    assert.equal(result.rows.length,2);
  }
  assert.equal(normalizeManifestPassengerRows({passengerNames:['Same Name','Same Name'],seatNumbers:[12,12]}).rows.length,1);
});
test('boarding statuses follow IDs through reorder/removal/addition rather than current positions', () => {
  const result = resolveSourcePassengerStatuses(roster([id('b'),id('c'),id('a')]), {
    rosterRevision:revision,passengerIdsJson:JSON.stringify([id('a'),id('b'),id('d')]),passengerStatusCodes:'BNB',
  });
  assert.deepEqual(result.statuses,['NO_SHOW','PENDING','BOARDED']);
});
test('primitive boarding codes are authoritative and stay bound to their stored full ID sequence', () => {
  const current=roster([id('b'),id('a')]);
  const result=resolveSourcePassengerStatuses(current,{rosterRevision:revision,
    passengerIdsJson:JSON.stringify([id('a'),id('b')]),passengerStatusCodes:'BN',
    passengerIds:[id('b'),id('a')],passengerStatus:['PENDING','PENDING']});
  assert.deepEqual(result.statuses,['NO_SHOW','BOARDED']);
  const reviewed=resolveSourcePassengerStatuses({...current,reviewRequired:true},{rosterRevision:revision,
    passengerIdsJson:JSON.stringify([id('a'),id('b')]),passengerStatusCodes:'BN'});
  assert.equal(reviewed.needsReview,false);
  const unmapped=resolveSourcePassengerStatuses(roster([id('c')],{reviewRequired:true}),{rosterRevision:revision,
    passengerIdsJson:JSON.stringify([id('a')]),passengerStatusCodes:'B'});
  assert.equal(unmapped.needsReview,true);
  const invalid=resolveSourcePassengerStatuses(current,{rosterRevision:revision,
    passengerIdsJson:JSON.stringify([id('a'),id('b')]),passengerStatusCodes:'B'});
  assert.deepEqual(invalid.statuses,['PENDING','PENDING']);
  assert.equal(invalid.needsReview,true);
});
test('legacy raw indices cannot prove presented status order and require review', () => {
  const value = roster([id('a'),id('b')],{legacyStatusCutoffMs:2000,
    legacyStatusIndexes:{[id('a')]:[2],[id('b')]:[]}});
  const result = resolveSourcePassengerStatuses(value,{lastUpdated:1000,passengerStatus:['NO_SHOW','PENDING','BOARDED']});
  assert.deepEqual(result.statuses,['PENDING','PENDING']);
  assert.equal(result.needsReview,true);
  const newer = resolveSourcePassengerStatuses(value,{lastUpdated:3000,passengerStatus:['BOARDED']});
  assert.deepEqual(newer.statuses,['PENDING','PENDING']);
  assert.equal(newer.needsReview,true);
  const sameLength = resolveSourcePassengerStatuses(value,{passengerStatus:['BOARDED','NO_SHOW']});
  assert.deepEqual(sameLength.statuses,['PENDING','PENDING']);
  assert.equal(sameLength.needsReview,true);
  const unprovenTyped = resolveSourcePassengerStatuses(value,{passengerIds:[id('a'),id('b')],passengerStatus:['BOARDED','NO_SHOW']});
  assert.deepEqual(unprovenTyped.statuses,['PENDING','PENDING']);
  assert.equal(unprovenTyped.needsReview,true);
});
test('malformed or duplicate IDs fail closed without falling back to positional data', () => {
  for (const ids of [[id('a')],[id('a'),id('a')],['Passenger name',id('b')]]) {
    assert.throws(()=>readSourceRoster({passengerDetails:[{},{}],sourceRoster:roster(ids)}),
      error=>error.code==='SOURCE_ROSTER_INVALID');
  }
  assert.equal(readSourceRoster({}),null);
  assert.equal(readSourceRoster({sourceRoster:{schemaVersion:1,state:'not_in_report',revision}}).state,'not_in_report');
});

const database = (state, afterRead) => ({ref(path) {
  const value = () => path.split('/').reduce((node,key)=>node?.[key], state);
  return {once:async()=>{const data=structuredClone(value()); afterRead?.(path); return {val:()=>data,exists:()=>data!=null};},
    orderByChild:field=>({equalTo:expected=>({once:async()=>({val:()=>Object.fromEntries(
      Object.entries(value() || {}).filter(([,row])=>row[field]===expected))})})})};
}});
test('whole manifest includes no-email and manual rows but excludes superseded source bookings', async () => {
  const state={tours:{TOUR_1:{tourCode:'TOUR 1'}},bookings:{
    ACTIVE:{tourId:'TOUR_1',loginEligible:false,passengerDetails:[{name:'Passenger A',seatNo:1}],sourceRoster:roster([id('a')])},
    OLD:{tourId:'TOUR_1',passengerNames:['Old row'],sourceRoster:{schemaVersion:1,state:'not_in_report',revision}},
    MANUAL:{tourId:'TOUR_1',source:'web-admin-manual',passengerNames:['Manual row']},
  },tour_manifests:{TOUR_1:{bookings:{ACTIVE:{rosterRevision:revision,passengerIdsJson:JSON.stringify([id('a')]),passengerStatusCodes:'B'}}}}};
  const result=await buildTourManifestPayload({tourId:'TOUR_1',db:database(state)});
  assert.deepEqual(result.bookings.map(row=>row.id),['ACTIVE','MANUAL']);
  assert.deepEqual(result.stats,{totalBookings:2,totalPax:2,checkedIn:1,noShows:0});
  assert.equal(result.bookings[0].rosterRevision,revision);
  assert.equal(JSON.stringify(result).includes('loginEligible'),false);
});
test('an import starting or completing during manifest reads prevents partial complete responses', async () => {
  const sync={schemaVersion:1,state:'ready',generation:revision,reportDate:'2026-10-10'};
  for (const change of [{...sync,state:'updating'},{...sync,generation:'b'.repeat(64)}]) {
    const state={tours:{TOUR_1:{rosterSync:sync}},bookings:{},tour_manifests:{}};
    const db=database(state,path=>{if(path==='tour_manifests/TOUR_1')state.tours.TOUR_1.rosterSync=change;});
    await assert.rejects(buildTourManifestPayload({tourId:'TOUR_1',db}),error=>error.code==='ROSTER_UPDATING');
  }
});
