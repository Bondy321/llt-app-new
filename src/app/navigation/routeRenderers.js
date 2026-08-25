'use strict';

import LoginScreen from '../../../screens/LoginScreen';
import TourHomeScreen from '../../../screens/TourHomeScreen';
import PhotobookScreen from '../../../screens/PhotobookScreen';
import GroupPhotobookScreen from '../../../screens/GroupPhotobookScreen';
import ItineraryScreen from '../../../screens/ItineraryScreen';
import ChatScreen from '../../../screens/ChatScreen';
import MapScreen from '../../../screens/MapScreen';
import NotificationPreferencesScreen from '../../../screens/NotificationPreferencesScreen';
import AccountPrivacyScreen from '../../../screens/AccountPrivacyScreen';
import DriverHomeScreen from '../../../screens/DriverHomeScreen';
import PassengerManifestScreen from '../../../screens/PassengerManifestScreen';
import SafetySupportScreen from '../../../screens/SafetySupportScreen';
import DriverItineraryScreen from '../../../screens/DriverItineraryScreen';
import DriverTourPackScreen from '../../../screens/DriverTourPackScreen';
import { resolveAuthScopedUserId, toRealtimeKeySegment } from '../../../services/identityService';
import { resolveTourId } from '../../../services/tourIdentityService';
import { SESSION_KEYS, SessionStorage } from '../session/sessionStorage';

const commonScreenProps = (context) => ({ isConnected: context.isConnected, logger: context.logger });

const renderLogin = (context) => (
  <LoginScreen
    {...commonScreenProps(context)}
    onLoginSuccess={context.handleLoginSuccess}
    resolveOfflineLogin={context.resolveOfflineLogin}
  />
);

const renderDriverHome = (context) => (
  <DriverHomeScreen
    driverData={context.bookingData}
    onLogout={context.handleLogout}
    onNavigate={context.navigateTo}
    onDriverAssignmentChange={context.handleDriverAssignmentChange}
    driverTourPackState={context.driverTourPackState}
    driverTourPackFeature={context.driverTourPackFeature}
  />
);

const renderDriverTourPack = (context) => {
  if (!context.driverTourPackFeature.enabled) return renderDriverHome(context);
  return (
    <DriverTourPackScreen
      packState={context.driverTourPackState}
      actionState={context.driverTourPackActions}
      isConnected={context.isConnected}
      tourData={context.tourData}
      driverData={context.bookingData}
      onBack={() => context.navigateBack('DriverHome')}
      onNavigate={context.navigateTo}
    />
  );
};

const renderSafetySupport = (context) => (
  <SafetySupportScreen
    onBack={() => context.navigateBack(context.screenParams?.from || 'TourHome')}
    tourData={context.tourData}
    bookingData={context.bookingData}
    userId={context.user?.uid}
    principalId={context.canonicalIdentity?.principalId}
    offlineCacheOwnerId={context.bookingData?.id}
    mode={context.screenParams?.mode || 'passenger'}
    isConnected={context.isConnected}
  />
);

const renderPassengerManifest = (context) => (
  <PassengerManifestScreen
    driverTourPack={context.driverTourPackState?.pack || null}
    isConnected={context.isConnected}
    route={{
      params: {
        ...context.screenParams,
        actorPrincipalId: context.canonicalIdentity?.principalId,
        authUid: context.canonicalIdentity?.authUid,
        offlineCacheOwnerId: context.bookingData?.id,
        sessionGeneration: context.driverSessionGeneration,
      },
    }}
    navigation={{
      navigate: context.navigateTo,
      goBack: () => context.navigateBack(context.screenParams?.from || 'DriverHome'),
    }}
  />
);

const renderTourHome = (context) => (
  <TourHomeScreen
    {...commonScreenProps(context)}
    tourCode={context.tourCode}
    tourData={context.tourData}
    bookingData={context.bookingData}
    onNavigate={context.navigateTo}
    onLogout={context.handleLogout}
  />
);

const renderPhotobook = (context) => (
  <PhotobookScreen
    {...commonScreenProps(context)}
    onBack={() => context.navigateBack('TourHome')}
    onViewerVisibilityChange={context.handleViewerVisibilityChange}
    tourId={context.tourData?.id}
    privatePhotoOwnerId={context.canonicalIdentity?.principalId}
    stablePassengerId={context.canonicalIdentity?.stablePassengerId || null}
    canonicalIdentity={context.canonicalIdentity}
  />
);

const renderGroupPhotobook = (context) => (
  <GroupPhotobookScreen
    {...commonScreenProps(context)}
    onBack={() => context.navigateBack('TourHome')}
    onViewerVisibilityChange={context.handleViewerVisibilityChange}
    userId={context.canonicalIdentity?.principalId}
    tourId={context.tourData?.id}
    userName={context.bookingData?.passengerNames?.[0] || 'Tour Member'}
    canonicalIdentity={context.canonicalIdentity}
  />
);

const renderItinerary = (context) => {
  const isDriver = context.screenParams.isDriver
    || (context.bookingData?.id && context.bookingData.id.startsWith('D-'));
  return (
    <ItineraryScreen
      {...commonScreenProps(context)}
      onBack={() => context.navigateBack(isDriver ? 'DriverHome' : 'TourHome')}
      tourId={context.screenParams.tourId || context.tourData?.id}
      tourName={context.tourData?.name}
      startDate={context.tourData?.startDate}
      isDriver={isDriver}
      offlineCacheOwnerId={context.bookingData?.id}
    />
  );
};

const renderDriverItinerary = (context) => (
  <DriverItineraryScreen
    {...commonScreenProps(context)}
    onBack={() => context.navigateBack('DriverHome')}
    tourId={context.screenParams.tourId || context.tourData?.id}
    tourName={context.tourData?.name}
    offlineCacheOwnerId={context.bookingData?.id}
  />
);

const renderChat = (context) => {
  const isDriver = context.screenParams.isDriver
    || (context.bookingData?.id && context.bookingData.id.startsWith('D-'));
  const effectiveBookingData = isDriver
    ? { isDriver: true, passengerNames: [context.screenParams.driverName || context.bookingData?.name || 'Driver'] }
    : { ...(context.bookingData || {}) };
  return (
    <ChatScreen
      {...commonScreenProps(context)}
      onBack={() => context.navigateBack(isDriver ? 'DriverHome' : 'TourHome')}
      tourId={resolveTourId(context.screenParams.tourId, context.tourData?.id, context.tourData?.tourCode)}
      bookingData={effectiveBookingData}
      tourData={context.tourData || { name: 'Tour Chat' }}
      internalDriverChat={context.screenParams.internalDriverChat === true}
      initialMessageId={context.screenParams.messageId || null}
      identityBinding={context.identityBinding}
      canonicalIdentity={context.canonicalIdentity}
      offlineSessionScope={context.offlineSessionScope}
    />
  );
};

const renderMap = (context) => {
  const returnTarget = context.screenParams?.from
    || (context.isDriverSession ? 'DriverHome' : 'TourHome');
  return (
    <MapScreen
      {...commonScreenProps(context)}
      onBack={() => context.navigateBack(returnTarget)}
      tourId={resolveTourId(context.screenParams.tourId, context.tourData?.id, context.tourData?.tourCode)}
      tourData={context.tourData}
      bookingData={context.bookingData}
    />
  );
};

const renderNotificationPreferences = (context) => {
  const returnTarget = context.screenParams?.returnTo
    || (context.isDriverSession ? 'DriverHome' : 'TourHome');
  const userId = resolveAuthScopedUserId({ canonicalIdentity: context.canonicalIdentity, authUser: context.user });
  return (
    <NotificationPreferencesScreen
      onBack={() => context.navigateBack(returnTarget, { from: 'NotificationPreferences' })}
      userId={userId}
      isOnboarding={context.screenParams?.isOnboarding === true}
      audience={context.screenParams?.audience || (context.isDriverSession ? 'driver' : 'passenger')}
      returnTo={returnTarget}
      onComplete={context.handleNotificationOnboardingComplete}
      tourId={context.tourData?.id}
      cacheOwnerId={toRealtimeKeySegment(context.canonicalIdentity?.principalId) || userId}
      initialMarketingCategoryKey={context.screenParams?.categoryKey || null}
      onNavigate={context.navigateTo}
    />
  );
};

const renderAccountPrivacy = (context) => (
  <AccountPrivacyScreen
    onBack={() => context.navigateBack(context.screenParams?.from || context.homeScreen)}
    onLogout={context.handleLogout}
    onAccountDeleted={context.handleAccountDeleted}
    tourData={context.tourData}
    bookingData={context.bookingData}
    canonicalIdentity={context.canonicalIdentity}
    identityBinding={context.identityBinding}
    isDriverSession={context.isDriverSession}
    sessionStorage={SessionStorage}
    sessionKeys={SESSION_KEYS}
  />
);

export const APP_ROUTE_RENDERERS = Object.freeze({
  AccountPrivacy: renderAccountPrivacy,
  Chat: renderChat,
  DriverHome: renderDriverHome,
  DriverItinerary: renderDriverItinerary,
  DriverTourPack: renderDriverTourPack,
  GroupPhotobook: renderGroupPhotobook,
  Itinerary: renderItinerary,
  Login: renderLogin,
  Map: renderMap,
  NotificationPreferences: renderNotificationPreferences,
  PassengerManifest: renderPassengerManifest,
  Photobook: renderPhotobook,
  SafetySupport: renderSafetySupport,
  TourHome: renderTourHome,
});

export const APP_ROUTE_NAMES = Object.freeze(Object.keys(APP_ROUTE_RENDERERS));
