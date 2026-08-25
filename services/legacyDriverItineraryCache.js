import AsyncStorage from '@react-native-async-storage/async-storage';

const legacyKey = (tourId) => `driver_itinerary_${tourId}`;

export const removeLegacyDriverItineraryCache = async (tourId) => {
  if (!tourId) return false;
  const key = legacyKey(tourId);
  const existingValue = await AsyncStorage.getItem(key);
  if (existingValue === null) return false;
  await AsyncStorage.removeItem(key);
  return true;
};
