import { realtimeDb } from '../firebase';

export const isTourHomeRealtimeAvailable = () => Boolean(realtimeDb);

export const subscribeToTourHomeRealtime = ({
  bookingRef,
  onDriverError,
  onDriverValue,
  onManifestError,
  onManifestValue,
  tourId,
}) => {
  if (!realtimeDb || !tourId || !bookingRef) return () => {};
  const manifestRef = realtimeDb.ref(`tour_manifests/${tourId}/bookings/${bookingRef}`);
  const driverRef = realtimeDb.ref(`tours/${tourId}/driverLocation`);
  manifestRef.on('value', onManifestValue, onManifestError);
  driverRef.on('value', onDriverValue, onDriverError);
  return () => {
    manifestRef.off('value', onManifestValue);
    driverRef.off('value', onDriverValue);
  };
};

export const readTourHomeRealtimeSnapshot = async ({ bookingRef, tourId }) => {
  if (!realtimeDb || !tourId || !bookingRef) return null;
  const [manifestSnapshot, driverSnapshot] = await Promise.all([
    realtimeDb.ref(`tour_manifests/${tourId}/bookings/${bookingRef}`).once('value'),
    realtimeDb.ref(`tours/${tourId}/driverLocation`).once('value'),
  ]);
  return { driverSnapshot, manifestSnapshot };
};
