import { useEffect } from 'react';
import {
  Platform,
} from 'react-native';
import * as Location from 'expo-location';
import * as Haptics from '../hapticsService';
import { realtimeDb } from '../../firebase';
import logger, { maskIdentifier } from '../loggerService';
import {
  createDriverLocationSessionId,
  withdrawLiveDriverLocation,
} from '../driverLocationService';
import {
  DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS,
} from '../../utils/driverLocation';
const AUTO_SHARE_INTERVAL_MS = 3 * 60 * 1000;


export default function createDriverLocationSharingActions(context) {
  const { activeTourId, activeTourIdRef, autoShareEnabled, autoShareEnabledRef, autoShareGenerationRef, autoShareInFlightRef, autoShareInitialLocationRef, autoSharePreferenceKey, autoShareSessionRef, autoShareToggleInFlightRef, captureCurrentLocationWithPermission, driverData, driverIdRef, getAddressFromCoords, isAppActive, isAppActiveRef, lastLocationAddressRef, locationBusyRef, locationSessionScope, persistenceRef, previewLocation, previewRequestIdRef, setAddressLoading, setAddressText, setAutoShareEnabled, setAutoShareLastRunAt, setAutoShareSaving, setAutoShareStatus, setJoinModalVisible, setLastLocationUpdate, setLocationAccuracy, setPreviewLocation, setPreviewModalVisible, setUpdatingLocation, showBanner, uploadLocationUpdate } = context;
  const handleToggleAutoShare = async (enabled) => {
    logger.info('DriverHomeScreen', 'Auto-share toggle requested', {
      activeTourId,
      enabled,
      hasAssignedTour: Boolean(activeTourId),
    });
    if (enabled && !activeTourId) {
      showBanner({
        type: 'warning',
        message: 'Join a tour before enabling auto-share.',
        actionLabel: 'Join Tour',
        actionHandler: () => setJoinModalVisible(true),
      });
      return;
    }
    if (enabled && (!locationSessionScope?.sessionId || !locationSessionScope?.authUid)) {
      showBanner({ type: 'warning', message: 'Your secure driver session is still syncing. Try again in a moment.' });
      return;
    }

    if (autoShareToggleInFlightRef.current) return;
    autoShareToggleInFlightRef.current = true;
    setAutoShareSaving(true);
    try {
      if (enabled) {
        const permission = await captureCurrentLocationWithPermission(Location.Accuracy.Balanced);
        if (!permission.success) {
          setAutoShareStatus('Paused: location permission required');
          showBanner({
            type: 'warning',
            message: 'Allow location access before enabling live bus sharing.',
          });
          return;
        }
        autoShareInitialLocationRef.current = permission.location;
      } else if (activeTourId) {
        const activeSession = autoShareSessionRef.current;
        autoShareGenerationRef.current += 1;
        autoShareSessionRef.current = null;
        autoShareEnabledRef.current = false;
        const withdrawal = await withdrawLiveDriverLocation({
          tourId: activeSession?.tourId || activeTourId,
          appSessionId: activeSession?.appSessionId || locationSessionScope?.sessionId,
          dbInstance: realtimeDb,
          expectedSessionId: activeSession?.sessionId,
        });
        if (withdrawal.removed) setLastLocationUpdate(null);
        setAutoShareLastRunAt(null);
      }

      await persistenceRef.current.setItemAsync(autoSharePreferenceKey, enabled ? 'true' : 'false');
      setAutoShareEnabled(enabled);
      setAutoShareStatus(enabled ? 'Waiting for the first live update' : 'Auto-share is off');
      logger.info('DriverHomeScreen', 'Auto-share preference saved', {
        driverId: maskIdentifier(driverData?.id),
        enabled,
      });
    } catch (error) {
      setAutoShareStatus(autoShareEnabled
        ? 'Live sharing is still on: could not safely turn it off'
        : 'Auto-share is off: change could not be saved');
      showBanner({
        type: 'error',
        message: enabled
          ? 'Live sharing could not be enabled safely. Try again.'
          : 'Live sharing could not be withdrawn. Check your connection and try again.',
        actionLabel: 'Retry',
        actionHandler: () => handleToggleAutoShare(enabled),
      });
      logger.warn('DriverHomeScreen', 'Auto-share preference save failed', {
        driverId: maskIdentifier(driverData?.id),
        enabled,
        error: error?.message || String(error),
      });
    } finally {
      autoShareToggleInFlightRef.current = false;
      setAutoShareSaving(false);
    }
  };

  useEffect(() => {
    if (!autoShareEnabled) return undefined;
    if (!activeTourId) {
      setAutoShareStatus('Paused: join a tour to resume auto-share');
      return undefined;
    }
    if (!isAppActive) {
      setAutoShareStatus('Paused while the app is in the background');
      return undefined;
    }

    let cancelled = false;
    let intervalId;
    const generation = autoShareGenerationRef.current + 1;
    const sessionId = createDriverLocationSessionId();
    const targetTourId = activeTourId;
    const targetDriverId = driverData?.id || '';
    const appSessionId = locationSessionScope?.sessionId || '';
    const session = { generation, sessionId, appSessionId, tourId: targetTourId, driverId: targetDriverId };
    autoShareGenerationRef.current = generation;
    autoShareSessionRef.current = session;
    const isScopeCurrent = () => (
      !cancelled
      && autoShareGenerationRef.current === generation
      && autoShareSessionRef.current?.sessionId === sessionId
      && autoShareEnabledRef.current
      && isAppActiveRef.current
      && activeTourIdRef.current === targetTourId
      && driverIdRef.current === targetDriverId
      && locationSessionScope?.sessionId === appSessionId
    );

    const runAutoShare = async () => {
      if (!isScopeCurrent() || locationBusyRef.current || autoShareInFlightRef.current === generation) return;

      autoShareInFlightRef.current = generation;
      try {
        setAutoShareStatus('Auto-share running (battery-aware mode)');
        logger.debug('DriverHomeScreen', 'Auto-share location capture started', {
          activeTourId: targetTourId,
          locationBusy: locationBusyRef.current,
        });
        const primedLocation = autoShareInitialLocationRef.current;
        autoShareInitialLocationRef.current = null;
        const primedAtMs = Number(primedLocation?.timestamp);
        const canUsePrimedLocation = primedLocation
          && Number.isFinite(primedAtMs)
          && Date.now() - primedAtMs < 30_000;
        const captureResult = canUsePrimedLocation
          ? { success: true, location: primedLocation }
          : await captureCurrentLocationWithPermission(Location.Accuracy.Balanced);

        if (!isScopeCurrent()) return;

        if (!captureResult.success) {
          setAutoShareStatus('Paused: location permission required');
          logger.warn('DriverHomeScreen', 'Auto-share paused by permission', {
            activeTourId: targetTourId,
            reason: captureResult.error,
          });
          return;
        }

        const location = captureResult.location;
        const timestamp = new Date().toISOString();
        const { latitude, longitude, accuracy } = location.coords;

        const uploadResult = await uploadLocationUpdate({
          latitude,
          longitude,
          accuracy,
          timestamp,
          address: lastLocationAddressRef.current,
        }, 'auto', {
          targetTourId,
          targetDriverId,
          sessionId,
          shouldUpdateLocalState: isScopeCurrent,
          isScopeCurrent,
        });

        if (uploadResult?.skipped) return;

        if (isScopeCurrent()) {
          setAutoShareLastRunAt(uploadResult.timestamp);
          setLocationAccuracy(accuracy);
          setAutoShareStatus(Number(accuracy) > DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS
            ? 'Low GPS accuracy: visible for context; retrying in 3 minutes'
            : 'Live: periodic updates every 3 minutes');
          logger.info('DriverHomeScreen', 'Auto-share location upload completed', {
            activeTourId: targetTourId,
            timestamp: uploadResult.timestamp,
            accuracy: Number.isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : null,
          });
        }
      } catch (error) {
        if (isScopeCurrent()) {
          setAutoShareStatus('Paused: network issue, will retry automatically');
          logger.warn('DriverHomeScreen', 'Auto-share run failed', {
            activeTourId: targetTourId,
            error: error?.message || String(error),
          });
        }
      } finally {
        if (autoShareInFlightRef.current === generation) autoShareInFlightRef.current = null;
      }
    };

    runAutoShare();
    intervalId = setInterval(runAutoShare, AUTO_SHARE_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      if (autoShareSessionRef.current?.sessionId === sessionId) {
        autoShareSessionRef.current = null;
        autoShareGenerationRef.current += 1;
      }
      withdrawLiveDriverLocation({
        tourId: targetTourId,
        appSessionId,
        dbInstance: realtimeDb,
        expectedSessionId: sessionId,
      }).catch((error) => {
        logger.warn('DriverHomeScreen', 'Live location withdrawal on lifecycle change failed', {
          activeTourId: targetTourId,
          error: error?.message || String(error),
        });
      });
    };
  }, [
    autoShareEnabled,
    activeTourId,
    driverData?.id,
    isAppActive,
    locationSessionScope?.authUid,
    locationSessionScope?.sessionId,
  ]);

  // Refetch location in preview modal
  const handleRefetchLocation = async () => {
    const currentPreview = previewLocation;
    if (!currentPreview) return;
    if (
      activeTourIdRef.current !== currentPreview.tourId
      || driverIdRef.current !== currentPreview.driverId
    ) {
      setPreviewModalVisible(false);
      setPreviewLocation(null);
      showBanner({ type: 'warning', message: 'Your tour assignment changed. Capture the pickup point again.' });
      return;
    }
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setUpdatingLocation(true);
    logger.info('DriverHomeScreen', 'Location preview refresh started', { activeTourId });

    try {
      const captureResult = await captureCurrentLocationWithPermission(Location.Accuracy.High);
      if (!captureResult.success) {
        showBanner({ type: 'warning', message: 'Allow location access before refreshing the pickup point.' });
        return;
      }
      const location = captureResult.location;

      const { latitude, longitude, accuracy } = location.coords;

      const nextPreview = {
        latitude,
        longitude,
        accuracy,
        timestamp: new Date().toISOString(),
        tourId: currentPreview.tourId,
        driverId: currentPreview.driverId,
        requestId,
      };

      setAddressLoading(true);
      const address = await getAddressFromCoords(latitude, longitude, currentPreview.tourId);
      if (
        previewRequestIdRef.current !== requestId
        || activeTourIdRef.current !== currentPreview.tourId
        || driverIdRef.current !== currentPreview.driverId
      ) return;
      setPreviewLocation(nextPreview);
      setLocationAccuracy(accuracy);
      setAddressText(address);
      setAddressLoading(false);
      logger.info('DriverHomeScreen', 'Location preview refresh completed', {
        activeTourId,
        accuracy: Number.isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : null,
      });

    } catch (error) {
      logger.error('DriverHomeScreen', 'Location preview refresh failed', {
        activeTourId,
        error: error?.message || String(error),
      });
      showBanner({
        type: 'error',
        message: 'Couldn’t refresh location. Retry.',
        actionLabel: 'Retry',
        actionHandler: handleRefetchLocation,
      });
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setAddressLoading(false);
        setUpdatingLocation(false);
      }
    }
  };


  return { handleToggleAutoShare, handleRefetchLocation };
}
