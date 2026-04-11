const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = TestRenderer;

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const waitForEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const createHost = (name) => {
  const Comp = ({ children, ...props }) => React.createElement(name, props, children);
  Comp.displayName = name;
  return Comp;
};

const extractText = (children) => {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractText).join('');
  return '';
};

const getAllText = (root) => root
  .findAll((node) => node.type === 'Text')
  .map((node) => extractText(node.props.children))
  .filter(Boolean);


const offlineSyncService = require('../services/offlineSyncService');

const originalLoad = Module._load;
Module._load = function mockLoader(request, parent, isMain) {
  if (request === 'react-native') {
    return {
      StyleSheet: { create: (styles) => styles },
      Text: createHost('Text'),
      View: createHost('View'),
      TouchableOpacity: createHost('TouchableOpacity'),
    };
  }

  if (request === '@expo/vector-icons') {
    return { MaterialCommunityIcons: createHost('MaterialCommunityIcons') };
  }

  if (request.endsWith('/theme') || request === '../theme') {
    return {
      COLORS: {
        border: '#E5E7EB',
        sync: {
          success: { background: '#D1FAE5', border: '#6EE7B7', foreground: '#065F46', foregroundMuted: '#047857' },
          warning: { background: '#FEF3C7', border: '#FCD34D', foreground: '#92400E', foregroundMuted: '#B45309' },
          critical: { background: '#FEE2E2', border: '#FCA5A5', foreground: '#991B1B', foregroundMuted: '#B91C1C' },
          info: { background: '#DBEAFE', border: '#93C5FD', foreground: '#1E40AF', foregroundMuted: '#1D4ED8' },
        },
      },
      RADIUS: { lg: 12, full: 9999 },
      SPACING: { xs: 4, sm: 8, md: 12 },
      SHADOWS: { sm: {} },
      FONT_WEIGHT: { medium: '500', semibold: '600', bold: '700' },
    };
  }

  if ((request.endsWith('/services/offlineSyncService') || request === '../services/offlineSyncService')
    && parent?.filename?.includes('components/SyncStatusBanner')) {
    return {
      __esModule: true,
      default: {
        formatLastSyncRelative: () => '5m ago',
      },
    };
  }

  return originalLoad(request, parent, isMain);
};


const clearQueue = async () => {
  const queued = await offlineSyncService.getQueuedActions();
  if (!queued.success) return;
  await Promise.all(queued.data.map((action) => offlineSyncService.removeAction(action.id)));
};

test.beforeEach(async () => {
  await clearQueue();
});

test('formatSyncOutcome returns canonical refresh copy from normalized summary input', () => {
  const output = offlineSyncService.formatSyncOutcome({ syncedCount: 4.6, pendingCount: 2, failedCount: -1 });
  assert.equal(output, '4 synced / 2 pending / 0 failed');
});

test('SyncStatusBanner renders visible sync status and last-success metadata from state/output props', async () => {
  const SyncStatusBanner = require('../components/SyncStatusBanner').default;

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(SyncStatusBanner, {
        state: {
          label: 'Sync backlog pending',
          description: 'Queued actions will replay automatically.',
          severity: 'warning',
          icon: 'clock-outline',
          canRetry: true,
          showLastSync: true,
        },
        outcomeText: '4 synced / 2 pending / 1 failed',
        retryLabel: 'Retry failed actions',
        lastSyncAt: Date.now() - (5 * 60 * 1000),
        onRetry: () => {},
      }),
    );
  });

  await waitForEffects();

  const text = getAllText(renderer.root).join('\n');
  assert.match(text, /Sync backlog pending/);
  assert.match(text, /Queued actions will replay automatically\./);
  assert.match(text, /4 synced \/ 2 pending \/ 1 failed/);
  assert.match(text, /Last successful sync 5m ago/);

  const retryButton = renderer.root
    .findAll((node) => node.type === 'TouchableOpacity')
    .find((node) => node.props.accessibilityLabel === 'Retry failed actions');
  assert.ok(retryButton);
});

test('SyncStatusBanner hides last-success copy when state.showLastSync is false', async () => {
  const SyncStatusBanner = require('../components/SyncStatusBanner').default;

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(SyncStatusBanner, {
        state: {
          label: 'Healthy',
          severity: 'success',
          icon: 'check-circle-outline',
          canRetry: false,
          showLastSync: false,
        },
        outcomeText: '3 synced / 0 pending / 0 failed',
        lastSyncAt: Date.now(),
      }),
    );
  });

  await waitForEffects();

  const text = getAllText(renderer.root).join('\n');
  assert.doesNotMatch(text, /Last successful sync/);
});

test('PHOTO_UPLOAD queue actions replay through injected photoService behavior', async () => {
  let uploadedPayload = null;

  const enqueue = await offlineSyncService.enqueueAction({
    id: `photo-upload-${Date.now()}`,
    type: 'PHOTO_UPLOAD',
    tourId: 'TOUR-1',
    payload: { uri: 'file://photo.jpg', tourId: 'TOUR-1', userId: 'USER-1' },
  });
  assert.equal(enqueue.success, true);

  const replay = await offlineSyncService.replayQueue({
    services: {
      photoService: {
        uploadPhotoDirect: async (payload) => {
          uploadedPayload = payload;
          return { success: true };
        },
      },
    },
  });

  assert.equal(replay.success, true);
  assert.equal(replay.data.processed, 1);
  assert.equal(uploadedPayload.tourId, 'TOUR-1');
  assert.equal(uploadedPayload.userId, 'USER-1');
  assert.equal(uploadedPayload.localAssets.sourceUri, 'file://photo.jpg');

  const queuedAfter = await offlineSyncService.getQueuedActions();
  assert.equal(queuedAfter.success, true);
  assert.equal(queuedAfter.data.length, 1);
  assert.equal(queuedAfter.data[0].status, 'completed');
});
