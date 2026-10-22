const test = require('node:test');
const assert = require('node:assert/strict');
const { mountDriverSession, INITIAL, assigned, deferred, act, flush, KEYS, APP_SESSION_KEY } = require('./helpers/mountedDriverSessionHarness');

test('fresh driver login initial session event cannot replace verified identity after onboarding', async () => {
  const h = await mountDriverSession();
  const onboarding = deferred(); const tourRead = deferred();
  h.controls.onboardingGate = onboarding; h.controls.tourGates.TOUR_A = tourRead;
  let login;
  try {
    assert.equal(h.state.bookingData, null);
    assert.equal(h.state.tourData, null);
    await act(async () => { login = h.login(INITIAL); await flush(); });
    await act(async () => { h.emit(INITIAL); await flush(); });
    assert.equal(h.calls.some(([event]) => event === 'tourRead'), false,
      'initial duplicate defers projection work to the active login');
    await act(async () => { onboarding.resolve(); await login; });
    await act(async () => { tourRead.resolve(); await flush(); });
    assert.equal(h.state.bookingData.id, INITIAL.driverId);
    assert.equal(JSON.parse(h.values.get(KEYS.BOOKING_DATA)).id, INITIAL.driverId);
    assert.equal(h.state.scope.driverId, INITIAL.driverId);
    assert.equal(h.state.scope.tourId, INITIAL.tourId);
  } finally { onboarding.resolve(); tourRead.resolve(); await h.flush(); await h.unmount(); }
});

const assertProjection = (h, session) => {
  assert.equal(h.rendered.driverMode, true);
  assert.equal(h.rendered.identity.principalId, session.principalId);
  assert.equal(h.rendered.identity.authUid, 'uid-demo');
  assert.equal(h.state.appSession.driverId, session.driverId);
  assert.equal(h.state.appSession.principalId, `driver:${session.driverId}`);
  assert.equal(h.state.appSession.sessionRevision, session.sessionRevision);
  assert.equal(h.state.bookingData.id, session.driverId);
  assert.equal(h.state.bookingData.assignedTourId, session.tourId);
  assert.equal(h.state.tourData?.id || null, session.tourId);
  assert.equal(JSON.parse(h.values.get(KEYS.BOOKING_DATA)).id, session.driverId);
  assert.equal(JSON.parse(h.values.get(KEYS.BOOKING_DATA)).assignedTourId, session.tourId);
  assert.equal(JSON.parse(h.values.get(KEYS.TOUR_DATA))?.id || null, session.tourId);
  if (session.tourId) {
    assert.equal(h.rendered.offlineAuthorized, true);
    assert.equal(h.rendered.offlineScope.tourId, session.tourId);
    assert.equal(h.rendered.operationalScope.ok, true);
    assert.equal(h.state.scope.driverId, session.driverId);
    assert.equal(h.state.scope.tourId, session.tourId);
    assert.equal(h.state.scope.authUid, 'uid-demo');
  } else assert.equal(h.state.scope, null);
};

for (const phase of ['onboarding', 'identity', 'pack']) {
  test(`higher assignment while fresh login awaits ${phase} cannot restore old seed or bypass onboarding`, async () => {
    const h = await mountDriverSession();
    const gate = deferred(); let login;
    h.controls[`${phase}Gate`] = gate; h.controls.onboard = true;
    try {
      await act(async () => { login = h.login(INITIAL); await flush(); });
      const next = assigned('TOUR_B', 2);
      await act(async () => { h.emit(next); await flush(); });
      assert.equal(h.state.appSession.tourId, 'TOUR_B');
      assert.equal(h.state.bookingData.id, INITIAL.driverId);
      await act(async () => { gate.resolve(); await login; await flush(); });
      assertProjection(h, next);
      assert.equal(h.state.currentScreen, 'NotificationPreferences');
      assert.deepEqual(h.state.screenParams, { isOnboarding: true, audience: 'driver', returnTo: 'DriverHome' });
      assert.equal(h.values.get(KEYS.LAST_SCREEN), 'NotificationPreferences');
      assert.equal(h.calls.filter(([event]) => event === 'stop').length, 1);
    } finally { gate.resolve(); await h.flush(); await h.unmount(); }
  });
}

test('genuinely unassigned fresh login retains verified identity and accepts its first assignment', async () => {
  const h = await mountDriverSession(); const unassigned = { ...INITIAL, tourId: null };
  try {
    await act(async () => { await h.login(unassigned); });
    assertProjection(h, unassigned);
    await act(async () => { h.emit(unassigned); await flush(); });
    const next = assigned('TOUR_B', 2);
    await act(async () => { h.emit(next); await flush(); });
    assertProjection(h, next);
    assert.equal(h.state.currentScreen, 'DriverHome');
  } finally { await h.unmount(); }
});

for (const end of ['null', 'expiry', 'replacement']) {
  test(`fresh login pending onboarding cannot restore authority after ${end}`, async () => {
    const h = await mountDriverSession(); const gate = deferred(); let login;
    h.controls.onboardingGate = gate;
    try {
      await act(async () => { login = h.login(INITIAL); await flush(); });
      await act(async () => {
        if (end === 'expiry') h.tick(20001);
        else h.emit(end === 'null' ? null : { ...INITIAL, sessionId: `sess_v1_${'b'.repeat(32)}` });
        await flush();
      });
      await act(async () => { gate.resolve(); await login; await flush(); });
      assert.equal(h.state.logoutStatus.state, 'complete');
      assert.equal(h.state.currentScreen, 'Login');
      assert.equal(h.state.appSession, null);
      assert.equal(h.state.bookingData, null);
      assert.equal(h.state.scope, null);
      assert.equal(h.values.has(APP_SESSION_KEY), false);
      assert.equal(h.values.has(KEYS.BOOKING_DATA), false);
      assert.equal(h.values.has(KEYS.TOUR_DATA), false);
      assert.equal(h.controls.cleanupCount, 1);
    } finally { gate.resolve(); await h.flush(); await h.unmount(); }
  });
}

for (const end of ['expiry', 'session replacement', 'principal replacement']) {
  test(`repaired assignment remains owned by mounted logout subscription on ${end}`, async () => {
    const h = await mountDriverSession({ initial: INITIAL });
    try {
      h.controls.failPurge = true;
      await act(async () => { h.emit(assigned('TOUR_B', 2)); await flush(); });
      h.controls.failPurge = false;
      await act(async () => { h.emit(assigned('TOUR_B', 2)); await flush(); });
      assertProjection(h, assigned('TOUR_B', 2));
      await act(async () => {
        if (end === 'expiry') h.tick(40001);
        else h.emit({ ...assigned('TOUR_B', 3), ...(end === 'session replacement'
          ? { sessionId: `sess_v1_${'b'.repeat(32)}` }
          : { driverId: 'D-OTHER', principalId: 'driver:D-OTHER' }) });
        await flush();
      });
      assert.equal(h.controls.cleanupCount, 1);
      assert.equal(h.state.logoutStatus.state, 'complete');
      assert.equal(h.state.currentScreen, 'Login');
      assert.equal(h.values.has(APP_SESSION_KEY), false);
      assert.equal(h.values.has(KEYS.BOOKING_DATA), false);
    } finally { await h.unmount(); }
  });
}

test('ordinary remote deletion control uses real captured cleanup and removes persistence', async () => {
  const h = await mountDriverSession({ initial: INITIAL });
  try {
    await act(async () => { h.emit(null); await flush(); });
    assert.equal(h.controls.cleanupCount, 1);
    assert.equal(h.state.logoutStatus.state, 'complete');
    assert.equal(await h.service.readSession(), null);
  } finally { await h.unmount(); }
});

test('old subscription callback cannot clear replacement during render-to-passive-cleanup interval', async () => {
  const h = await mountDriverSession({ initial: INITIAL });
  try {
    const oldCallback = h.capturedListeners[0];
    const replacement = { ...INITIAL, sessionId: `sess_v1_${'b'.repeat(32)}` };
    await h.service.persistSession(replacement);
    await act(async () => { h.setSession(replacement); oldCallback({ val: () => null }); await flush(); });
    assert.equal(h.controls.cleanupCount, 0);
    assert.equal(h.state.logoutStatus.state, 'idle');
    assert.deepEqual(await h.service.readSession(), replacement);
    await act(async () => { oldCallback({ val: () => null }); await flush(); });
    assert.equal(h.controls.cleanupCount, 0);
  } finally { await h.unmount(); }
});

test('revision-only renewal and repeated duplicates retain work and route, but latest expiry still cleans up', async () => {
  const h = await mountDriverSession({ initial: INITIAL });
  try {
    const oldTimer = [...h.timers.values()][0];
    const renewed = assigned('TOUR_A', 2);
    await act(async () => { h.emit(renewed); await flush(); });
    for (let index = 0; index < 4; index += 1) {
      await act(async () => { h.emit(renewed); await flush(); });
    }
    assert.equal(h.calls.filter(([event]) => ['stop', 'purge', 'routeReset', 'tourRead'].includes(event)).length, 0);
    assert.equal(h.listeners.size, 1);
    assert.equal(h.capturedListeners.length, 2, 'no duplicate subscription loop');
    await act(async () => { h.controls.now = 20001; oldTimer.callback(); await flush(); });
    assert.equal(h.state.logoutStatus.state, 'idle');
    await act(async () => { h.tick(40001); await flush(); });
    assert.equal(h.state.logoutStatus.state, 'complete');
    assert.equal(h.controls.cleanupCount, 1);
    assert.equal(h.values.has(APP_SESSION_KEY), false);
  } finally { await h.unmount(); }
});

test('accepted expiry remains effective while assignment tour loading is pending', async () => {
  const h = await mountDriverSession({ initial: INITIAL }); const gate = deferred();
  h.controls.tourGates.TOUR_B = gate;
  try {
    await act(async () => { h.emit(assigned('TOUR_B', 2, 5000)); await flush(); });
    await act(async () => { h.tick(5001); await flush(); });
    assert.equal(h.state.logoutStatus.state, 'requesting');
    await act(async () => { gate.resolve(); await flush(); });
    assert.equal(h.state.logoutStatus.state, 'complete');
    assert.equal(h.state.bookingData, null);
    assert.equal(h.values.has(APP_SESSION_KEY), false);
    assert.equal(h.values.has(KEYS.TOUR_DATA), false);
  } finally { gate.resolve(); await h.flush(); await h.unmount(); }
});

test('save callback captured before activation cannot write old identity or assignment over current authority', async () => {
  const h = await mountDriverSession(); const capturedSave = h.deps.saveSession;
  try {
    await act(async () => { await h.login(INITIAL); });
    const next = assigned('TOUR_B', 2);
    await act(async () => { h.emit(next); await flush(); });
    await capturedSave({ tourData: { id: 'TOUR_A' }, bookingData: { id: 'D-DEMO', assignedTourId: 'TOUR_A' }, currentScreen: 'DriverHome' });
    assertProjection(h, next);
    await act(async () => { h.emit(null); await flush(); });
    await capturedSave({ tourData: { id: 'TOUR_A' }, bookingData: { id: 'D-DEMO', assignedTourId: 'TOUR_A' }, currentScreen: 'DriverHome' });
    assert.equal(h.values.has(KEYS.BOOKING_DATA), false);
  } finally { await h.unmount(); }
});

for (const phase of ['prepare', 'onboarding']) {
  test(`an older fresh login paused in ${phase} cannot activate or overwrite a newer login`, async () => {
    const h = await mountDriverSession(); const gate = deferred(); let oldLogin;
    h.controls[`${phase}Gate`] = gate;
    try {
      await act(async () => { oldLogin = h.login(INITIAL); await flush(); });
      h.controls[`${phase}Gate`] = null;
      const replacement = { ...assigned('TOUR_B', 1), sessionId: `sess_v1_${'b'.repeat(32)}` };
      await act(async () => { await h.login(replacement); });
      await act(async () => { gate.resolve(); await oldLogin; await flush(); });
      assertProjection(h, replacement);
      assert.equal(h.state.appSession.sessionId, replacement.sessionId);
      assert.equal(h.state.currentScreen, 'DriverHome');
      assert.deepEqual(await h.service.readSession(), replacement);
    } finally { gate.resolve(); await h.flush(); await h.unmount(); }
  });
}

for (const phase of ['onboarding', 'pack']) {
  test(`explicit logout while fresh login awaits ${phase} drains relevant work and prevents late resurrection`, async () => {
    const h = await mountDriverSession(); const gate = deferred(); let login; let logout;
    h.controls[`${phase}Gate`] = gate;
    try {
      await act(async () => { login = h.login(INITIAL); await flush(); });
      assert.equal(h.state.scope, null, 'tour access is withheld until its persistent seed is committed');
      await act(async () => { logout = h.logout(); await flush(); });
      await act(async () => { gate.resolve(); await login; await logout; await flush(); });
      assert.equal(h.state.logoutStatus.state, 'complete');
      assert.equal(h.state.currentScreen, 'Login');
      assert.equal(h.state.bookingData, null);
      assert.equal(h.values.has(APP_SESSION_KEY), false);
      assert.equal(h.values.has(KEYS.BOOKING_DATA), false);
      assert.equal(h.values.has(KEYS.TOUR_DATA), false);
      assert.equal(h.controls.cleanupCount, 1);
    } finally { gate.resolve(); await h.flush(); await h.unmount(); }
  });
}

test('mounted duplicate assignment repair still acts on genuine remote deletion', async () => {
  const h = await mountDriverSession({ initial: INITIAL });
  try {
    h.controls.failPurge = true;
    await act(async () => { h.emit(assigned('TOUR_B', 2)); await flush(); });
    h.controls.failPurge = false;
    await act(async () => { h.emit(assigned('TOUR_B', 2)); await flush(); });
    assert.equal(h.state.tourData.id, 'TOUR_B');
    await act(async () => { h.emit(null); await flush(); });
    assert.equal(h.controls.cleanupCount, 1);
    assert.equal(h.state.logoutStatus.state, 'complete');
    assert.equal(h.state.appSession, null);
    assert.equal(h.values.has(APP_SESSION_KEY), false);
    assert.equal(h.values.has(KEYS.BOOKING_DATA), false);
  } finally { await h.unmount(); }
});

test('onboarding resolves while B tour read is pending, completes once, and C never reopens it', async () => {
  const h = await mountDriverSession(); const onboarding = deferred(); const tour = deferred(); let login;
  h.controls.onboardingGate = onboarding; h.controls.tourGates.TOUR_B = tour; h.controls.onboard = true;
  try {
    await act(async () => { login = h.login(INITIAL); await flush(); });
    await act(async () => { h.emit(assigned('TOUR_B', 2)); await flush(); });
    await act(async () => { onboarding.resolve(); await login; await flush(); });
    assert.equal(h.state.currentScreen, 'NotificationPreferences');
    await act(async () => { tour.resolve(); await flush(); });
    assertProjection(h, assigned('TOUR_B', 2));
    assert.equal(h.values.get(KEYS.LAST_SCREEN), 'NotificationPreferences');
    await act(async () => { await h.completeOnboarding(); });
    assert.equal(h.state.currentScreen, 'DriverHome');
    await act(async () => { h.emit(assigned('TOUR_C', 3)); await flush(); });
    assertProjection(h, assigned('TOUR_C', 3));
    assert.equal(h.state.currentScreen, 'DriverHome');
    assert.equal(h.values.get(KEYS.LAST_SCREEN), 'DriverHome');
  } finally { onboarding.resolve(); tour.resolve(); await h.flush(); await h.unmount(); }
});

test('HTTP renewal immediately fences old timer before passive subscription replacement', async () => {
  const h = await mountDriverSession({ initial: INITIAL });
  try {
    const oldTimer = [...h.timers.values()][0]; const renewed = assigned('TOUR_A', 2);
    await act(async () => {
      const accepted = h.deps.reconcileDriverSession({ authUid: 'uid-demo', session: renewed });
      h.controls.now = 20001;
      oldTimer.callback();
      await accepted; await flush();
    });
    assert.equal(h.state.logoutStatus.state, 'idle');
    assert.equal(h.controls.cleanupCount, 0);
    assert.deepEqual(await h.service.readSession(), renewed);
    await act(async () => { h.tick(40001); await flush(); });
    assert.equal(h.state.logoutStatus.state, 'complete');
    assert.equal(h.controls.cleanupCount, 1);
  } finally { await h.unmount(); }
});

test('newly observed expired revision is actionable even before HTTP renewal effect commits', async () => {
  const h = await mountDriverSession({ initial: INITIAL });
  try {
    await act(async () => {
      const accepted = h.deps.reconcileDriverSession({ authUid: 'uid-demo', session: assigned('TOUR_A', 2) });
      h.controls.now = 6000;
      h.emit(assigned('TOUR_A', 3, 5000));
      await accepted; await flush();
    });
    assert.equal(h.state.logoutStatus.state, 'complete');
    assert.equal(h.controls.cleanupCount, 1);
    assert.equal(h.values.has(APP_SESSION_KEY), false);
  } finally { await h.unmount(); }
});

test('driver can create a complete fresh projection after a previous logout completed', async () => {
  const h = await mountDriverSession({ initial: INITIAL });
  try {
    await act(async () => { await h.logout(); });
    assert.equal(h.state.logoutStatus.state, 'complete');
    const replacement = { ...assigned('TOUR_B', 1), sessionId: `sess_v1_${'b'.repeat(32)}` };
    await act(async () => { await h.login(replacement); });
    assertProjection(h, replacement);
    assert.equal(h.state.currentScreen, 'DriverHome');
  } finally { await h.unmount(); }
});

for (const wait of ['final diagnostic', 'route storage read']) {
  test(`onboarding completed during ${wait} cannot be reopened by late login completion`, async () => {
    const h = await mountDriverSession(); const gate = deferred(); let login;
    h.controls.onboard = true;
    if (wait === 'final diagnostic') h.controls.completedDiagnosticGate = gate;
    else { h.controls.pauseSessionRead = 2; h.controls.sessionReadGate = gate; }
    try {
      await act(async () => { login = h.login(INITIAL); await flush(); });
      assert.equal(h.state.currentScreen, 'NotificationPreferences');
      await act(async () => { await h.completeOnboarding(); await flush(); });
      assert.equal(h.state.currentScreen, 'DriverHome');
      await act(async () => { gate.resolve(); await login; await flush(); });
      assertProjection(h, INITIAL);
      assert.equal(h.state.currentScreen, 'DriverHome');
      assert.equal(h.values.get(KEYS.LAST_SCREEN), 'DriverHome');
      await act(async () => { h.emit(assigned('TOUR_B', 2)); await flush(); });
      assert.equal(h.state.currentScreen, 'DriverHome');
    } finally { gate.resolve(); await h.flush(); await h.unmount(); }
  });
}
