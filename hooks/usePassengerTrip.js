import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import logger from '../services/loggerService';
const { createPassengerTripController } = require('../services/passenger-trip/tripController');
const { createTripApi } = require('../services/passenger-trip/tripApi');
const { getTripCache } = require('../services/passenger-trip/tripCache');
const { normalizeScope, scopeKey, seedEnvelope } = require('../services/passenger-trip/tripBoundary');
const { registerTripController } = require('../services/passenger-trip/tripLifecycle');
const { readLegacyTripSeed } = require('../services/passenger-trip/legacyTripSeed');

export const passengerTripEnabled = () => process.env.EXPO_PUBLIC_PASSENGER_TRIP_ENABLED === 'true';

export default function usePassengerTrip({ scope: offlineScope, bookingData, tourData, isConnected, enabled, onInvalidSession }) {
  const scope = offlineScope ? { authUid: offlineScope.authUid, principalId: offlineScope.principalId,
    bookingRef: offlineScope.cacheOwnerId, tourId: offlineScope.tourId, sessionId: offlineScope.sessionId } : null;
  const ownerKey = enabled && normalizeScope(scope) ? scopeKey(scope) : null;
  const controllerRef = useRef(null);
  const latest = useRef(null);
  latest.current = { scope, bookingData, tourData, isConnected, onInvalidSession };
  const [snapshot, setSnapshot] = useState(null);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    setSnapshot(null);
    if (!ownerKey) return undefined;
    const initial = latest.current;
    const api = createTripApi();
    const controller = createPassengerTripController({
      scope: initial.scope, seed: seedEnvelope(initial.scope, initial.bookingData, initial.tourData),
      cache: getTripCache(), request: api.request, subscribeSignals: api.subscribeSignals,
      migrateSeed: readLegacyTripSeed,
      onInvalidSession: (event) => latest.current.onInvalidSession?.(event),
      diagnostics: (event, details) => logger.debug('PassengerTrip', event, details),
    });
    controllerRef.current = controller;
    setSnapshot(controller.getState());
    const unsubscribe = controller.subscribe(setSnapshot);
    const unregister = registerTripController(controller);
    controller.setAvailability(initial.isConnected, AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
    const appState = AppState.addEventListener('change', (state) => {
      setNowMs(Date.now());
      controller.setAvailability(latest.current.isConnected, state === 'active');
    });
    const timer = setInterval(() => setNowMs(Date.now()), 60000);
    return () => {
      unsubscribe(); unregister(); appState.remove(); clearInterval(timer);
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [ownerKey]);
  useEffect(() => {
    controllerRef.current?.setAvailability(isConnected, AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  }, [isConnected]);
  const refresh = useCallback((reason, parts) => controllerRef.current?.refresh(reason, parts) || Promise.resolve(), []);
  return useMemo(() => {
    if (!ownerKey) return null;
    const valid = snapshot && scopeKey(snapshot.scope) === ownerKey ? snapshot : null;
    return { parts: valid?.parts || {}, refresh, nowMs };
  }, [ownerKey, snapshot, refresh, nowMs]);
}
