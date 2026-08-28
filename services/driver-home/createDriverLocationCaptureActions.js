import {
  Alert,
  Platform,
  Animated,
  Linking,
} from 'react-native';
import * as Location from 'expo-location';
import * as Haptics from '../hapticsService';
import { realtimeDb } from '../../firebase';
import logger, { maskIdentifier } from '../loggerService';
import {
  publishDriverLocation,
} from '../driverLocationService';
import {
  DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS,
} from '../../utils/driverLocation';
export default function createDriverLocationCaptureActions(context) {
  const { activeTourId, activeTourIdRef, addressText, driverData, driverIdRef, locationAccuracy, locationSessionScope, previewLocation, previewRequestIdRef, setAddressLoading, setAddressText, setConfirmingLocation, setJoinModalVisible, setLastLocationUpdate, setLocationAccuracy, setPreviewLocation, setPreviewModalVisible, setUpdatingLocation, showBanner, successAnim } = context;
  const getAddressFromCoords = async (latitude, longitude, targetTourId) => {
    try {
      logger.debug('DriverHomeScreen', 'Reverse geocode started', {
        activeTourId: targetTourId,
        latitudeApprox: Number.isFinite(Number(latitude)) ? Number(Number(latitude).toFixed(3)) : null,
        longitudeApprox: Number.isFinite(Number(longitude)) ? Number(Number(longitude).toFixed(3)) : null,
      });
      const result = await Location.reverseGeocodeAsync({
        latitude,
        longitude,
      });

      if (result && result.length > 0) {
        const addr = result[0];
        const parts = [];
        if (addr.name && addr.name !== addr.street) parts.push(addr.name);
        if (addr.street) parts.push(addr.street);
        if (addr.city) parts.push(addr.city);
        if (addr.region) parts.push(addr.region);

        const address = parts.join(', ') || 'Address unavailable';
        logger.info('DriverHomeScreen', 'Reverse geocode completed', {
          activeTourId: targetTourId,
          resultCount: result.length,
          hasAddress: parts.length > 0,
        });
        return address;
      } else {
        logger.warn('DriverHomeScreen', 'Reverse geocode returned no results', { activeTourId: targetTourId });
        return 'Address unavailable';
      }
    } catch (error) {
      logger.warn('DriverHomeScreen', 'Reverse geocode failed', {
        activeTourId: targetTourId,
        error: error?.message || String(error),
      });
      return 'Could not determine address';
    }
  };

  const captureCurrentLocationWithPermission = async (accuracy = Location.Accuracy.High) => {
    logger.debug('DriverHomeScreen', 'Location permission check started', { activeTourId, accuracy });
    const existingPermission = await Location.getForegroundPermissionsAsync();
    let permissionStatus = existingPermission?.status;

    if (permissionStatus !== 'granted') {
      logger.info('DriverHomeScreen', 'Location permission request started', { activeTourId, previousStatus: permissionStatus });
      const requestedPermission = await Location.requestForegroundPermissionsAsync();
      permissionStatus = requestedPermission?.status;
    }

    if (permissionStatus !== 'granted') {
      logger.warn('DriverHomeScreen', 'Location permission denied', { activeTourId, permissionStatus });
      return { success: false, error: 'permission-denied' };
    }

    const location = await Location.getCurrentPositionAsync({ accuracy });
    logger.info('DriverHomeScreen', 'Location captured', {
      activeTourId,
      accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
      requestedAccuracy: accuracy,
    });
    return { success: true, location };
  };

  const uploadLocationUpdate = async (
    { latitude, longitude, accuracy, timestamp, address },
    source = 'manual',
    {
      targetTourId = activeTourId,
      targetDriverId = driverData?.id || '',
      shouldUpdateLocalState = () => true,
      isScopeCurrent = () => true,
      sessionId,
    } = {}
  ) => {
    logger.info('DriverHomeScreen', 'Driver location upload started', {
      activeTourId: targetTourId,
      driverId: maskIdentifier(targetDriverId),
      source,
      hasAddress: Boolean(address),
      accuracy: Number.isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : null,
      latitudeApprox: Number.isFinite(Number(latitude)) ? Number(Number(latitude).toFixed(3)) : null,
      longitudeApprox: Number.isFinite(Number(longitude)) ? Number(Number(longitude).toFixed(3)) : null,
    });
    const persistedLocation = await publishDriverLocation({
      tourId: targetTourId,
      location: { latitude, longitude, accuracy, timestamp },
      updatedBy: driverData.name,
      address: address || 'Address unavailable',
      source,
      dbInstance: realtimeDb,
      isScopeCurrent,
      sessionId,
      sessionScope: locationSessionScope,
      driverId: targetDriverId,
    });
    if (persistedLocation.skipped) {
      logger.info('DriverHomeScreen', 'Driver location upload skipped for revoked scope', {
        activeTourId: targetTourId,
        source,
      });
      return persistedLocation;
    }
    logger.info('DriverHomeScreen', 'Driver location upload completed', {
      activeTourId: targetTourId,
      source,
      timestamp,
    });

    if (shouldUpdateLocalState()) {
      setLastLocationUpdate(persistedLocation.storedLocation || {
        ...persistedLocation,
        latitude,
        longitude,
        updatedBy: driverData.name,
        address: address || 'Address unavailable',
        accuracy,
      });
    }
    return persistedLocation;
  };

  // Function to capture location and show preview
  const handleCaptureLocation = async () => {
    const targetTourId = activeTourId;
    const targetDriverId = driverData?.id || '';
    if (!targetTourId) {
      logger.warn('DriverHomeScreen', 'Manual location capture blocked without tour', {
        driverId: maskIdentifier(driverData?.id),
      });
      showBanner({
        type: 'warning',
        message: 'Join a tour to share your pickup location.',
        actionLabel: 'Join Tour',
        actionHandler: () => setJoinModalVisible(true),
      });
      return;
    }
    if (!locationSessionScope?.sessionId || !locationSessionScope?.authUid) {
      showBanner({ type: 'warning', message: 'Your secure driver session is still syncing. Try again in a moment.' });
      return;
    }

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setUpdatingLocation(true);
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setAddressLoading(true);
    logger.info('DriverHomeScreen', 'Manual location capture started', { activeTourId: targetTourId });

    try {
      // 1. Request Permission
      const captureResult = await captureCurrentLocationWithPermission(Location.Accuracy.High);
      if (!captureResult.success) {
        logger.warn('DriverHomeScreen', 'Manual location capture blocked by permission', {
          activeTourId: targetTourId,
          reason: captureResult.error,
        });
        Alert.alert(
          'Location access needed',
          'Allow location access in your device settings to share the pickup point.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Open settings',
              onPress: () => Linking.openSettings().catch((error) => {
                logger.warn('DriverHomeScreen', 'Device settings could not be opened', {
                  error: error?.message || String(error),
                });
                Alert.alert('Settings unavailable', 'Open your device settings and allow location access for this app.');
              }),
            },
          ],
        );
        setUpdatingLocation(false);
        return;
      }

      // 2. Get Coordinates with high accuracy
      const location = captureResult.location;

      const { latitude, longitude, accuracy } = location.coords;
      if (
        previewRequestIdRef.current !== requestId
        || activeTourIdRef.current !== targetTourId
        || driverIdRef.current !== targetDriverId
      ) return;

      const nextPreview = {
        latitude,
        longitude,
        accuracy,
        timestamp: new Date().toISOString(),
        tourId: targetTourId,
        driverId: targetDriverId,
        requestId,
      };

      // 3. Get address
      const address = await getAddressFromCoords(latitude, longitude, targetTourId);
      if (
        previewRequestIdRef.current !== requestId
        || activeTourIdRef.current !== targetTourId
        || driverIdRef.current !== targetDriverId
      ) return;

      setPreviewLocation(nextPreview);
      setLocationAccuracy(accuracy);
      setAddressText(address);
      setAddressLoading(false);

      // 4. Show preview modal
      setPreviewModalVisible(true);
      logger.info('DriverHomeScreen', 'Manual location preview ready', {
        activeTourId: targetTourId,
        accuracy: Number.isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : null,
      });

    } catch (error) {
      logger.error('DriverHomeScreen', 'Manual location capture failed', {
        activeTourId,
        error: error?.message || String(error),
      });
      showBanner({
        type: 'error',
        message: 'Couldn’t get your location. Retry.',
        actionLabel: 'Retry',
        actionHandler: handleCaptureLocation,
      });
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setAddressLoading(false);
        setUpdatingLocation(false);
      }
    }
  };

  // Function to confirm and save location to Firebase
  const handleConfirmLocation = async () => {
    if (!previewLocation) return;

    const { tourId: targetTourId, driverId: targetDriverId } = previewLocation;
    if (activeTourIdRef.current !== targetTourId || driverIdRef.current !== targetDriverId) {
      setPreviewModalVisible(false);
      setPreviewLocation(null);
      showBanner({ type: 'warning', message: 'Your tour assignment changed. Capture the pickup point again.' });
      return;
    }
    if (Number(locationAccuracy) > DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS) {
      showBanner({ type: 'warning', message: 'Location accuracy is too low. Refresh the pin before sharing.' });
      return;
    }

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }

    setConfirmingLocation(true);
    logger.info('DriverHomeScreen', 'Manual location confirm started', { activeTourId: targetTourId });

    try {
      const { latitude, longitude, timestamp } = previewLocation;

      const isScopeCurrent = () => (
        activeTourIdRef.current === targetTourId
        && driverIdRef.current === targetDriverId
      );
      const result = await uploadLocationUpdate(
        { latitude, longitude, timestamp, address: addressText, accuracy: locationAccuracy },
        'manual',
        { targetTourId, targetDriverId, isScopeCurrent }
      );
      if (result?.skipped) {
        setPreviewModalVisible(false);
        setPreviewLocation(null);
        showBanner({ type: 'warning', message: 'Your tour assignment changed. No location was shared.' });
        return;
      }

      // Success animation
      Animated.sequence([
        Animated.timing(successAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.delay(1500),
        Animated.timing(successAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();

      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      setPreviewModalVisible(false);
      showBanner({
        type: 'success',
        message: 'Location shared. Passengers can now see your pickup point.',
      });
      logger.info('DriverHomeScreen', 'Manual location confirm completed', {
        activeTourId,
        accuracy: Number.isFinite(Number(locationAccuracy)) ? Math.round(Number(locationAccuracy)) : null,
      });

    } catch (error) {
      logger.error('DriverHomeScreen', 'Manual location confirm failed', {
        activeTourId,
        error: error?.message || String(error),
      });
      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      showBanner({
        type: 'error',
        message: 'Couldn’t share location. Retry.',
        actionLabel: 'Retry',
        actionHandler: handleConfirmLocation,
      });
    } finally {
      setConfirmingLocation(false);
    }
  };


  return { getAddressFromCoords, captureCurrentLocationWithPermission, uploadLocationUpdate, handleCaptureLocation, handleConfirmLocation };
}
