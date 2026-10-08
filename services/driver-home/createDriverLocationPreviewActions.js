import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as Haptics from '../hapticsService';
import logger from '../loggerService';

export default function createDriverLocationPreviewActions(context) {
  const { activeTourId, activeTourIdRef, driverIdRef, captureCurrentLocationWithPermission, previewLocation, previewRequestIdRef, setPreviewModalVisible, setPreviewLocation, showBanner, setUpdatingLocation, setAddressLoading, getAddressFromCoords, setLocationAccuracy, setAddressText } = context;
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


  return { handleRefetchLocation };
}
