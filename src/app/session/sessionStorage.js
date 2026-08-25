'use strict';

import AsyncStorage from '@react-native-async-storage/async-storage';
import logger from '../../../services/loggerService';
import { isTestRuntime } from '../../shared/config/runtimeEnvironment';

export const SESSION_KEYS = Object.freeze({
  TOUR_DATA: '@LLT:tourData',
  BOOKING_DATA: '@LLT:bookingData',
  LAST_SCREEN: '@LLT:lastScreen',
  NOTIFICATION_ONBOARDING: '@LLT:notificationOnboarding',
  IDENTITY_BINDING: '@LLT:identityBinding',
});

const createMemoryStorage = () => {
  const data = {};
  return {
    multiGet: async (keys) => keys.map((key) => [key, data[key] || null]),
    multiSet: async (entries) => {
      entries.forEach(([key, value]) => { data[key] = value; });
    },
    multiRemove: async (keys) => {
      keys.forEach((key) => { delete data[key]; });
    },
  };
};

export const createSessionStorage = () => {
  try {
    if (AsyncStorage?.multiGet && AsyncStorage?.multiSet && AsyncStorage?.multiRemove) {
      return { storage: AsyncStorage, mode: 'async-storage', enabled: true };
    }
  } catch (error) {
    logger.warn('SessionStorage', 'AsyncStorage unavailable, falling back to mock', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (isTestRuntime()) {
    return { storage: createMemoryStorage(), mode: 'memory-test', enabled: true };
  }
  const unavailable = async () => {
    const error = new Error('Durable session storage is unavailable');
    error.code = 'SESSION_STORAGE_UNAVAILABLE';
    throw error;
  };
  return {
    storage: { multiGet: unavailable, multiSet: unavailable, multiRemove: unavailable },
    mode: 'unavailable',
    enabled: false,
  };
};

const sessionStorage = createSessionStorage();
export const SessionStorage = sessionStorage.storage;
export const storageMode = sessionStorage.mode;
