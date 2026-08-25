import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder } from 'react-native';
import logger from '../../../services/loggerService';
import { isEligibleEdgeSwipe, shouldCommitEdgeSwipeHome } from '../../../services/swipeHomeNavigation';
import { createAppRouteHistory } from '../../../utils/appRouteHistory';
import { SESSION_KEYS, SessionStorage } from '../session/sessionStorage';

export default function useAppNavigation({ driverTourPackFeature, homeScreen, persistScreen }) {
  const [currentScreen, setCurrentScreen] = useState('Login');
  const [screenParams, setScreenParams] = useState({});
  const [isImageViewerVisible, setIsImageViewerVisible] = useState(false);
  const routeHistoryRef = useRef(createAppRouteHistory());
  const persistScreenRef = useRef(persistScreen);
  persistScreenRef.current = persistScreen;

  useEffect(() => {
    if (currentScreen !== 'DriverTourPack'
      || driverTourPackFeature.loading
      || driverTourPackFeature.enabled) return;
    routeHistoryRef.current.reset();
    setCurrentScreen('DriverHome');
    setScreenParams({});
    SessionStorage.setItem(SESSION_KEYS.LAST_SCREEN, 'DriverHome').catch(() => undefined);
  }, [currentScreen, driverTourPackFeature.enabled, driverTourPackFeature.loading]);

  const navigateTo = useCallback((screen, params = {}, options = {}) => {
    logger.trackScreen(screen, { from: currentScreen, ...params });
    if (options.reset === true) {
      routeHistoryRef.current.reset();
    } else if (options.replace !== true && screen !== currentScreen) {
      routeHistoryRef.current.push({ screen: currentScreen, params: screenParams });
    }
    setScreenParams(params);
    setCurrentScreen(screen);
    persistScreenRef.current({ currentScreen: screen });
  }, [currentScreen, screenParams]);

  const navigateBack = useCallback((fallbackScreen, fallbackParams = {}) => {
    const target = routeHistoryRef.current.pop({ fallbackScreen, fallbackParams });
    if (!target) return;
    logger.trackScreen(target.screen, { from: currentScreen, via: 'back' });
    setScreenParams(target.params);
    setCurrentScreen(target.screen);
    persistScreenRef.current({ currentScreen: target.screen });
  }, [currentScreen]);

  const handleViewerVisibilityChange = useCallback((visible) => {
    setIsImageViewerVisible(Boolean(visible));
  }, []);

  const canSwipeToHome = currentScreen !== 'Login'
    && currentScreen !== 'TourHome'
    && currentScreen !== 'DriverHome'
    && currentScreen !== 'Chat'
    && !isImageViewerVisible;

  const edgeSwipeResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gestureState) => (
      canSwipeToHome && isEligibleEdgeSwipe(gestureState)
    ),
    onPanResponderRelease: (_, gestureState) => {
      if (!canSwipeToHome || !shouldCommitEdgeSwipeHome(gestureState)) return;
      logger.info('Navigation', 'Edge swipe home navigation triggered', {
        from: currentScreen,
        to: homeScreen,
        dx: gestureState?.dx,
        vx: gestureState?.vx,
      });
      navigateTo(homeScreen, { viaGesture: 'edge-swipe-home' }, { reset: true });
    },
    onPanResponderTerminationRequest: () => true,
  }), [canSwipeToHome, currentScreen, homeScreen, navigateTo]);

  return {
    currentScreen,
    edgeSwipeResponder,
    handleViewerVisibilityChange,
    navigateBack,
    navigateTo,
    routeHistoryRef,
    screenParams,
    setCurrentScreen,
    setScreenParams,
  };
}
