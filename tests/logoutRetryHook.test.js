const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const { act, create } = require('react-test-renderer');
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalLoad = Module._load;
let attempts = 0;
let succeed = false;
let completed;
const expectedSessionId = `sess_v1_${'a'.repeat(32)}`;
Module._load = function load(request, parent, isMain) {
  if (request === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
  if (request.endsWith('/services/appSessionService')) return {
    retryPendingEnd: async () => { attempts += 1; return { success: succeed, reason: 'SESSION_IN_PROGRESS', pending: { sessionId: expectedSessionId } }; },
    completeEnd: async input => { completed = input; return true; },
  };
  if (request.endsWith('/services/localSessionCleanupService')) return {};
  if (request.endsWith('/services/loggerService')) return { info() {}, warn() {} };
  return originalLoad(request, parent, isMain);
};
const useLogoutLifecycle = require('../src/app/session/useLogoutLifecycle').default;
Module._load = originalLoad;
let retry;
let currentStatus;
let route;
function Probe({ online }) {
  const [logoutStatus, setLogoutStatus] = React.useState({ state: 'pending_network' });
  currentStatus = logoutStatus;
  const context = React.useRef(null);
  const generation = React.useRef(0);
  retry = useLogoutLifecycle({ appSession: null, userUid: null, isConnected: online,
    logoutContextRef: context, sessionGenerationRef: generation, logoutStatus, setLogoutStatus,
    setCurrentScreen: screen => { route = screen; } });
  return null;
}

test('logout retries back off, pause offline, coalesce manual taps and finish only the exact operation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let renderer;
  try {
    await act(async () => { renderer = create(React.createElement(Probe, { online: true })); });
    assert.equal(attempts, 0);
    await act(async () => t.mock.timers.tick(999));
    assert.equal(attempts, 0);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(attempts, 1);
    assert.equal(currentStatus.state, 'pending_network');
    await act(async () => t.mock.timers.tick(1999));
    assert.equal(attempts, 1);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(attempts, 2);
    await act(async () => renderer.update(React.createElement(Probe, { online: false })));
    await act(async () => t.mock.timers.tick(60000));
    assert.equal(attempts, 2);
    await act(async () => renderer.update(React.createElement(Probe, { online: true })));
    succeed = true;
    await act(async () => { await Promise.all([retry(), retry()]); });
    assert.equal(attempts, 3);
    assert.deepEqual(completed, { expectedSessionId });
    assert.equal(currentStatus.state, 'complete');
    assert.equal(route, 'Login');
    await act(async () => t.mock.timers.tick(60000));
    assert.equal(attempts, 3);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    t.mock.timers.reset();
  }
});
