import { realtimeDb } from '../firebase';

export const getDriverLocationRef = (tourId) => realtimeDb.ref(`tours/${tourId}/driverLocation`);

export const getRealtimeConnectionRef = () => realtimeDb.ref('.info/connected');
