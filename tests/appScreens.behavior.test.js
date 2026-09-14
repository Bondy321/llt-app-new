const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { create, act } = require('react-test-renderer');
const nativeMocks = require('./helpers/passengerTripNativeMocks');
require('@babel/register')({ extensions: ['.js', '.jsx'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const noop = () => {};
const success = async () => ({ success: true, data: [] });
const host = (name) => ({ children, ...props }) => React.createElement(name, props, children);
const identity = { principalId: 'passenger:test', stablePassengerId: 'test', authUid: 'test-auth', principalType: 'passenger' };
const storage = { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} };
let manifestBookings = [];
let reports = [];
let enqueued = [];
let ownerRefreshes = 0;
let photos = [];
let mapPoint = null;
let mapError = false;
let messages = [];
let subscriptionError = false;
const subscribe = (_tour, callback, _db, options) => { if (subscriptionError) options.onError(new Error('offline')); else callback(messages); return noop; };
const offline = {
  getPhotoUploadActions: success,
  normalizeSessionScope: (value) => value || null, getLastSuccessAt: success, getQueuedActions: success,
  subscribeQueuedActions: () => noop, replayQueue: success, enqueueAction: async (action) => { enqueued.push(action); return { success: true }; }, updateAction: success, removeAction: success,
};
nativeMocks.install({ resolveModule(request) {
  if (request === '@react-native-community/netinfo') return { fetch: async () => ({ isConnected: true, type: 'wifi' }) };
  if (request === 'expo-media-library') return {};
  if (request === 'expo-image') return { Image: host('ExpoImage') };
  if (request === 'expo-image-picker') return { requestMediaLibraryPermissionsAsync: async () => ({ status: 'granted' }), launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///test.jpg' }] }) };
  if (request === 'expo-file-system/legacy') return { getInfoAsync: async () => ({ exists: true }) };
  if (request === '@react-native-clipboard/clipboard') return { setString: noop };
  if (request === 'expo-clipboard') return { setStringAsync: async () => {} };
  if ((request.endsWith('/services/persistenceProvider') || request === './persistenceProvider')) return { createPersistenceProvider: () => storage };
  if (request.endsWith('/services/driverManifestCacheService')) return {};
  if (request.endsWith('/services/bookingServiceRealtime')) return {
    MANIFEST_STATUS: { BOARDED: 'BOARDED', PENDING: 'PENDING', NO_SHOW: 'NO_SHOW', PARTIAL: 'PARTIAL' },
    getTourManifest: async () => ({ bookings: manifestBookings, stats: {} }),
    updateManifestBooking: async (_tour, id, statuses) => {
      manifestBookings = manifestBookings.map((booking) => booking.id === id ? { ...booking, status: statuses[0], passengerStatus: statuses } : booking);
      return { status: statuses[0], passengerStatus: statuses };
    },
  };
  if (request.endsWith('/services/authStateService')) return { getCurrentAuthUser: () => ({ uid: 'test-auth' }), updateCurrentAuthUserProfile: async () => { ownerRefreshes += 1; return { success: true }; } };
  if (request.endsWith('/services/imageOptimizationService')) return { optimizeSourcePhotoForUpload: async (photo) => ({ uploadUri: photo.uri }), formatBytes: String };
  if (request === 'react-native-maps') return { __esModule: true, default: host('MapView'), Marker: host('Marker'), Polyline: host('Polyline'), Circle: host('Circle') };
  if (request === 'expo-location') return { getForegroundPermissionsAsync: async () => ({ status: 'denied' }) };
  if (request.endsWith('/services/mapRealtimeService')) return {
    getRealtimeConnectionRef: () => ({ on: (_event, callback) => { callback({ val: () => true }); return noop; }, off: noop }),
    getDriverLocationRef: () => ({ on: (_event, callback, onError) => { if (mapError) onError(new Error('offline')); else callback({ exists: () => Boolean(mapPoint), val: () => mapPoint }); return noop; }, off: noop }),
  };
  if (request.endsWith('/services/photoService')) return {
    fetchPrivatePhotosPage: async () => ({ items: photos, hasMore: false }),
    fetchTourPhotosPage: async () => ({ items: photos, hasMore: false }),
    subscribeToPrivatePhotos: () => noop, subscribeToTourPhotos: () => noop,
  };
  if (request.endsWith('/services/contentModerationService')) return { checkTextForObjectionableContent: () => ({ allowed: true }), createContentReport: async (report) => { reports.push(report); return { success: true }; } };
  if (request.endsWith('/services/offlineSyncService')) return { __esModule: true, default: offline, ...offline };
  if (request.endsWith('/services/chatService')) return {
    subscribeToChatMessages: subscribe, subscribeToInternalDriverChat: subscribe,
    subscribeToTypingIndicators: () => noop, subscribeToPresence: () => noop,
    sendMessage: async (_tour, text, _sender, _db, options) => ({ success: true, message: { id: options.messageId, text, timestamp: Date.now() } }),
    sendInternalDriverMessage: async (_tour, text, _sender, _db, options) => ({ success: true, message: { id: options.messageId, text, timestamp: Date.now() } }),
    markChatAsRead: success, markInternalChatAsRead: success, setTypingStatus: success, setOnlinePresence: success,
    getChatMessagesPage: async () => ({ success: true, messages: [{ id: 'older', text: 'Earlier update', timestamp: 1000 }], hasMore: false }),
  };
  return undefined;
} });
test.after(() => nativeMocks.restore());

for (const internalDriverChat of [false, true]) {
  for (const state of ['empty', 'messages', 'error']) {
    test(`chat renders ${state}, search and reply controls (driver=${internalDriverChat})`, async () => {
      messages = state === 'messages' ? [{ id: 'm1', text: 'Meet at the coach', timestamp: Date.now(), senderId: 'other', senderName: 'Tour member', senderType: 'passenger' }] : [];
      subscriptionError = state === 'error';
      const Screen = require('../components/chat/ChatController').default;
      const View = require('../components/chat/ChatView').default;
      let renderer;
      try {
        await act(async () => { renderer = create(React.createElement(Screen, { tourId: 'TEST', canonicalIdentity: internalDriverChat ? { principalId: 'driver:test', authUid: 'test-auth', principalType: 'driver' } : identity, bookingData: { id: 'TEST123', isDriver: internalDriverChat }, internalDriverChat })); });
        const view = () => renderer.root.findByType(View).props;
        assert.equal(view().loading, false);
        assert.equal(Boolean(view().chatLoadError), state === 'error');
        assert.equal(view().messages.length, messages.length);
        await act(async () => { view().setIsSearchOpen(true); view().setSearchQuery('coach'); });
        if (state === 'messages') {
          assert.equal(view().filteredSearchResults.length, 1);
          await act(async () => view().handleLoadOlderMessages());
          assert.ok(view().messages.some((message) => message.id === 'older'));
          await act(async () => view().handleReplyToMessage(messages[0]));
          await act(async () => view().handleTextChange('Test reply'));
          await act(async () => view().handleSendMessage());
          assert.ok(view().messages.some((message) => message.text === 'Test reply' && message.status === 'sent'));
        }
      } finally { if (renderer) await act(async () => renderer.unmount()); }
    });
  }
}

for (const group of [false, true]) {
  for (const populated of [false, true]) {
    test(`photobook renders and opens upload controls (group=${group}, populated=${populated})`, async () => {
      photos = populated ? [{ id: 'photo1', url: 'https://example.com/photo.jpg', thumbnailUrl: 'https://example.com/thumb.jpg', timestamp: Date.now(), userId: 'passenger:test', caption: 'Tour photo' }] : [];
      const Screen = require(group ? '../components/group-photobook/GroupPhotobookController' : '../components/photobook/PhotobookController').default;
      const View = require(group ? '../components/group-photobook/GroupPhotobookView' : '../components/photobook/PhotobookView').default;
      let renderer;
      try {
        await act(async () => { renderer = create(React.createElement(Screen, { tourId: 'TEST', canonicalIdentity: identity, privatePhotoOwnerId: 'test', stablePassengerId: 'test', userId: 'passenger:test' })); });
        const view = () => renderer.root.findByType(View).props;
        assert.equal(view().loadingPhotos, false);
        assert.ok(view().thumbnailTileStyle);
        if (group) await act(async () => view().showUploadOptions());
        enqueued = [];
        const beforeOwnerRefreshes = ownerRefreshes;
        await act(async () => view().handlePickFromGallery());
        await act(async () => view().handleUpload());
        assert.equal(enqueued.length, 1);
        assert.equal(enqueued[0].payload.visibility, group ? 'group' : 'private');
        if (!group) assert.ok(ownerRefreshes > beforeOwnerRefreshes);
        if (populated) {
          await act(async () => group ? view().openViewer(0, 0) : view().openViewer('photo1'));
          assert.equal(view().viewerVisible, true);
          if (group) {
            reports = [];
            await act(async () => view().handleReportPhoto(photos[0], 'spam'));
            assert.equal(reports[0].reporterAuthUid, 'test-auth');
          }
        }
      } finally { if (renderer) await act(async () => renderer.unmount()); }
    });
  }
}
for (const state of ['empty', 'live', 'error']) {
  test(`map renders ${state} without location permission`, async () => {
    mapPoint = state === 'live' ? { latitude: 56, longitude: -4, timestamp: Date.now(), source: 'live', updatedBy: 'Test driver' } : null;
    mapError = state === 'error';
    const Screen = require('../components/map/MapScreenController').default;
    const View = require('../components/map/MapScreenView').default;
    let renderer;
    try {
      await act(async () => { renderer = create(React.createElement(Screen, { tourId: 'TEST' })); });
      const props = renderer.root.findByType(View).props;
      assert.equal(props.loading, false);
      assert.equal(Boolean(props.errorMsg), mapError);
      assert.ok(props.freshnessConfig.label);
      assert.equal(Boolean(props.driverLocation), state === 'live');
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });
}

test('driver manifest saves a boarding update and offers the next unresolved booking', async () => {
  manifestBookings = ['TEST1', 'TEST2'].map((id) => ({ id, passengerNames: ['Test passenger'], status: 'PENDING', passengerStatus: ['PENDING'] }));
  const Screen = require('../components/passenger-manifest/PassengerManifestController').default;
  const View = require('../components/passenger-manifest/PassengerManifestView').default;
  let renderer;
  try {
    await act(async () => { renderer = create(React.createElement(Screen, { route: { params: { tourId: 'TEST', actorPrincipalId: 'driver:test', authUid: 'test-auth' } }, navigation: { goBack: noop } })); });
    const view = () => renderer.root.findByType(View).props;
    assert.equal(view().loading, false);
    await act(async () => view().handleOpenBooking(manifestBookings[0]));
    await act(async () => view().handleSetAll('BOARDED'));
    assert.equal(view().statusFeedback.variant, 'success');
    assert.equal(manifestBookings[0].status, 'BOARDED');
    assert.equal(view().statusFeedback.nextBooking.id, 'TEST2');
    await act(async () => view().handleOpenBooking(view().statusFeedback.nextBooking));
    assert.equal(view().selectedBooking.id, 'TEST2');
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});
