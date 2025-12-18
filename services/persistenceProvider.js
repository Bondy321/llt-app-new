// services/persistenceProvider.js
// Centralized, crash-safe persistence layer with SecureStore -> AsyncStorage -> in-memory fallback.
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const defaultLogger = {
  debug: (msg, data) => console.log(`[Persistence][debug] ${msg}`, data || ''),
  info: (msg, data) => console.log(`[Persistence][info] ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`[Persistence][warn] ${msg}`, data || ''),
  error: (msg, data) => console.error(`[Persistence][error] ${msg}`, data || ''),
};

const createStorageCandidate = (name, handlers) => ({
  name,
  ...handlers,
});

export const createPersistenceProvider = ({ namespace = 'LLT', logger = defaultLogger } = {}) => {
  const namespacedKey = (key) => `${namespace}:${key}`;

  const candidates = [
    createStorageCandidate('secure-store', {
      isAvailable: () => Boolean(SecureStore?.setItemAsync && SecureStore?.getItemAsync && SecureStore?.deleteItemAsync),
      async setItemAsync(key, value) {
        return SecureStore.setItemAsync(namespacedKey(key), value, { keychainAccessible: SecureStore.ALWAYS_THIS_DEVICE_ONLY });
      },
      async getItemAsync(key) {
        return SecureStore.getItemAsync(namespacedKey(key));
      },
      async deleteItemAsync(key) {
        return SecureStore.deleteItemAsync(namespacedKey(key));
      }
    }),
    createStorageCandidate('async-storage', {
      isAvailable: () => Boolean(AsyncStorage?.setItem && AsyncStorage?.getItem && AsyncStorage?.removeItem),
      async setItemAsync(key, value) {
        return AsyncStorage.setItem(namespacedKey(key), value);
      },
      async getItemAsync(key) {
        return AsyncStorage.getItem(namespacedKey(key));
      },
      async deleteItemAsync(key) {
        return AsyncStorage.removeItem(namespacedKey(key));
      }
    }),
    createStorageCandidate('memory-mock', {
      isAvailable: () => true,
      store: {},
      async setItemAsync(key, value) {
        this.store[namespacedKey(key)] = value;
      },
      async getItemAsync(key) {
        return this.store[namespacedKey(key)] || null;
      },
      async deleteItemAsync(key) {
        delete this.store[namespacedKey(key)];
      }
    })
  ];

  let active = candidates.find((candidate) => {
    try {
      return candidate.isAvailable();
    } catch (error) {
      logger.warn(`Storage candidate ${candidate.name} failed availability check`, { error: error?.message });
      return false;
    }
  });

  if (!active) {
    active = candidates[candidates.length - 1];
  }

  logger.info('Persistence provider selected', { mode: active.name });

  const safeCall = async (fnName, key, value) => {
    try {
      return await active[fnName](key, value);
    } catch (error) {
      logger.error(`Persistence provider ${active.name} failed for ${fnName}`, { key: namespacedKey(key), error: error?.message });
      if (active.name !== 'memory-mock') {
        logger.warn('Falling back to in-memory persistence after failure', { previousMode: active.name });
        active = candidates[candidates.length - 1];
      }
    }

    return undefined;
  };

  return {
    mode: active.name,
    async setItemAsync(key, value) {
      return safeCall('setItemAsync', key, value);
    },
    async getItemAsync(key) {
      return safeCall('getItemAsync', key);
    },
    async deleteItemAsync(key) {
      return safeCall('deleteItemAsync', key);
    }
  };
};

export default createPersistenceProvider;
