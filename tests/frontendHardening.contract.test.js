const test = require('node:test');
const { readAppArchitectureSource, readMobileModuleSource } = require('./helpers/readAppArchitectureSource');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readSource = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('diagnostics cleanup removes only its own Firebase callback and ignores stale generations', () => {
  const source = readSource('hooks/useDiagnostics.js');

  assert.match(source, /effectGenerationRef/);
  assert.match(source, /generation !== effectGenerationRef\.current/);
  assert.match(source, /\.off\('value', firebaseListenerRef\.current\.callback\)/);
  assert.doesNotMatch(source, /\.off\(\)/);
  assert.match(source, /refreshSyncMetaInFlightRef\.current === generation/);
});

test('app back navigation restores the actual caller and edge-swipe navigation resets history', () => {
  const source = readAppArchitectureSource();

  assert.match(source, /routeHistoryRef\.current\.push\(\{ screen: currentScreen, params: screenParams \}\)/);
  assert.match(source, /routeHistoryRef\.current\.pop\(\{ fallbackScreen, fallbackParams \}\)/);
  assert.match(source, /setScreenParams\(target\.params\)/);
  assert.match(source, /navigateTo\(homeScreen, \{ viaGesture: 'edge-swipe-home' \}, \{ reset: true \}\)/);
  assert.match(source, /const edgeSwipeResponder = useMemo\(\(\) => PanResponder\.create/);
});

test('web bus map keeps implementation details and raw coordinates out of customer copy', () => {
  const source = readSource('screens/MapScreen.web.js');

  assert.match(source, /Find my bus/);
  assert.match(source, /latest bus location/i);
  assert.doesNotMatch(source, /lightweight fallback/i);
  assert.doesNotMatch(source, /Latitude|Longitude|\.toFixed\(/);
});

test('live bus map has a bounded initial wait and a recoverable timeout state', () => {
  const source = readMobileModuleSource('screens/MapScreen.js');

  assert.match(source, /DRIVER_LOCATION_INITIAL_TIMEOUT_MS = 10000/);
  assert.match(source, /setTimeout\(/);
  assert.match(source, /clearTimeout\(initialSnapshotTimeout\)/);
  assert.match(source, /Retry now or use your booked pickup directions/);
});

test('manifest bulk no-show is confirmed and the booking modal can scroll above the keyboard', () => {
  const source = readMobileModuleSource('screens/PassengerManifestScreen.js');

  assert.match(source, /Mark this booking as no-show\?/);
  assert.match(source, /style: 'destructive'/);
  assert.match(source, /KeyboardAvoidingView/);
  assert.match(source, /<ScrollView[\s\S]*keyboardShouldPersistTaps="handled"/);
  assert.match(source, /accessibilityLabel=\{`Mark all passengers here for booking/);
  assert.match(source, /accessibilityLabel="Search passengers or bookings"/);
  assert.match(source, /accessibilityLabel=\{`Show \$\{item\.label\.toLowerCase\(\)\} bookings`\}/);
});

test('a no-show passenger can dismiss the interruption without hiding their status', () => {
  const source = readMobileModuleSource('screens/TourHomeScreen.js');

  assert.match(source, /noShowAcknowledged/);
  assert.match(source, /I understand — continue to tour/);
  assert.match(source, /accessibilityViewIsModal/);
  assert.match(source, /isNoShow && !noShowAcknowledged/);
  assert.match(source, /modalCard:[\s\S]*maxHeight: '92%'/);
  assert.match(source, /contentContainerStyle=\{styles\.modalScrollContent\}/);
});

test('photo selection failures and driver location denial have explicit recovery paths', () => {
  const privateGallery = readMobileModuleSource('screens/PhotobookScreen.js');
  const groupGallery = readMobileModuleSource('screens/GroupPhotobookScreen.js');
  const driverHome = readMobileModuleSource('screens/DriverHomeScreen.js');

  [privateGallery, groupGallery].forEach((source) => {
    assert.match(source, /Photos unavailable/);
    assert.match(source, /Camera unavailable/);
    assert.match(source, /catch \(error\)/);
  });
  assert.match(driverHome, /Open settings/);
  assert.match(driverHome, /Linking\.openSettings\(\)/);
});

test('high-frequency icon controls and gallery tiles expose accessible names and touch targets', () => {
  const chat = readMobileModuleSource('screens/ChatScreen.js');
  const itinerary = readMobileModuleSource('screens/ItineraryScreen.js');
  const galleryTile = readSource('components/GalleryPhotoTile.js');

  assert.match(chat, /accessibilityLabel="Previous search result"/);
  assert.match(chat, /syncNowBtn:[\s\S]*width: 44,[\s\S]*height: 44/);
  assert.match(itinerary, /accessibilityLabel="Search itinerary"/);
  assert.match(itinerary, /headerIconButton: \{ minWidth: 44, minHeight: 44/);
  assert.match(galleryTile, /accessibilityLabel=\{accessibilityLabel\}/);
  assert.match(galleryTile, /accessibilityState=\{\{ disabled \}\}/);
});
