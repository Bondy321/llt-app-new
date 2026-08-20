const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const TestRenderer = require('react-test-renderer');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = TestRenderer;
const useDriverTourPack = require('../hooks/useDriverTourPack').default;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const scope = (departureKey = '2026-08-20::TOUR_1') => ({
  authUid: 'auth-one',
  driverId: 'D-ONE',
  departureKey,
});

const pack = (revision, departureKey = '2026-08-20::TOUR_1') => ({
  departureKey,
  revision,
  status: 'active',
  expiresAtMs: Date.now() + 60_000,
  generatedAtMs: Date.now(),
  quality: { state: 'complete' },
});

const createService = ({ cachedPack = pack(1), remotePack = pack(2), remoteResult } = {}) => {
  const subscriptions = [];
  const calls = { fetch: 0, unsubscribe: 0 };
  return {
    calls,
    subscriptions,
    normalizeScope: (input) => ({ ok: true, ...input }),
    load: async () => cachedPack
      ? { success: true, data: { pack: cachedPack, revision: cachedPack.revision, freshness: { state: 'ready' } } }
      : { success: true, data: null },
    fetchRemote: async () => {
      calls.fetch += 1;
      if (remoteResult) return remoteResult;
      return { success: true, data: { pack: remotePack, revision: remotePack.revision, freshness: { state: 'ready' } } };
    },
    subscribeRevision: (normalized, onChange, onError) => {
      const subscription = { normalized, onChange, onError, active: true };
      subscriptions.push(subscription);
      return () => {
        if (subscription.active) calls.unsubscribe += 1;
        subscription.active = false;
      };
    },
    purge: async () => ({ success: true }),
  };
};

function Harness({ driverScope, service, onState }) {
  const state = useDriverTourPack(driverScope, { service });
  React.useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
}

test('uses cache immediately and fetches the full pack only after semantic revision changes', async () => {
  const service = createService();
  const states = [];
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, {
      driverScope: scope(),
      service,
      onState: (value) => states.push(value),
    }));
  });
  await flush();

  assert.equal(states.at(-1).source, 'cache');
  assert.equal(states.at(-1).revision, 1);
  assert.equal(service.calls.fetch, 0);

  await act(async () => service.subscriptions[0].onChange({ revision: 1 }));
  await flush();
  assert.equal(service.calls.fetch, 0);

  await act(async () => service.subscriptions[0].onChange({ revision: 2 }));
  await flush();
  assert.equal(service.calls.fetch, 1);
  assert.equal(states.at(-1).source, 'remote');
  assert.equal(states.at(-1).revision, 2);

  await act(async () => renderer.unmount());
  assert.equal(service.calls.unsubscribe, 1);
});

test('keeps a valid cached pack visible when a changed revision fetch fails', async () => {
  const service = createService({
    remoteResult: { success: false, error: 'permission denied' },
  });
  const states = [];
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, {
      driverScope: scope(),
      service,
      onState: (value) => states.push(value),
    }));
  });
  await flush();
  await act(async () => service.subscriptions[0].onChange({ revision: 2 }));
  await flush();

  assert.equal(states.at(-1).pack.revision, 1);
  assert.equal(states.at(-1).source, 'cache');
  assert.equal(states.at(-1).error, 'permission denied');
  await act(async () => renderer.unmount());
});

test('scope changes unsubscribe immediately and ignore an old in-flight full fetch', async () => {
  let resolveOldFetch;
  const service = createService();
  service.fetchRemote = () => {
    service.calls.fetch += 1;
    return new Promise((resolve) => { resolveOldFetch = resolve; });
  };
  const states = [];
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, {
      driverScope: scope(),
      service,
      onState: (value) => states.push(value),
    }));
  });
  await flush();
  await act(async () => service.subscriptions[0].onChange({ revision: 2 }));

  await act(async () => {
    renderer.update(React.createElement(Harness, {
      driverScope: scope('2026-08-21::TOUR_2'),
      service,
      onState: (value) => states.push(value),
    }));
  });
  await flush();
  assert.equal(service.subscriptions[0].active, false);

  await act(async () => resolveOldFetch({
    success: true,
    data: { pack: pack(2), revision: 2, freshness: { state: 'ready' } },
  }));
  await flush();

  assert.notEqual(states.at(-1).scope?.departureKey, '2026-08-20::TOUR_1');
  await act(async () => renderer.unmount());
});
