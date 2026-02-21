// services/persistenceProvider.js
// Centralized, crash-safe persistence layer with SecureStore -> AsyncStorage -> in-memory fallback.
let SecureStore;
let AsyncStorage;

try {
  SecureStore = require('expo-secure-store');
} catch (error) {
  SecureStore = null;
}

try {
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
} catch (error) {
  AsyncStorage = null;
}

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

const isReactNativeRuntime = (runtime = {}) => {
  if (typeof runtime.isReactNative === 'boolean') {
    return runtime.isReactNative;
  }

  const globalObj = runtime.globalObject || globalThis;
  const navigatorObj = runtime.navigatorObject || (typeof navigator !== 'undefined' ? navigator : undefined);

  return Boolean(
    navigatorObj?.product === 'ReactNative'
    || globalObj?.nativeCallSyncHook
    || globalObj?.__fbBatchedBridgeConfig
    || globalObj?.HermesInternal
  );
};

const createPersistenceProvider = ({
  namespace = 'LLT',
  logger = defaultLogger,
  secureStoreAdapter,
  asyncStorageAdapter,
  runtime = {},
} = {}) => {
  const namespacedKey = (key) => `${namespace}_${key}`;
  const secureStore = secureStoreAdapter || SecureStore;
  const asyncStorage = asyncStorageAdapter || AsyncStorage;
  const hasInjectedStorageAdapter = Boolean(secureStoreAdapter || asyncStorageAdapter);
  const inTestEnv = (runtime.nodeEnv || process?.env?.NODE_ENV) === 'test';
  const nativeRuntime = isReactNativeRuntime(runtime);

  const candidates = [
    createStorageCandidate('secure-store', {
      isAvailable: () => {
        if (!nativeRuntime && !secureStoreAdapter) {
          return false;
        }

        return Boolean(secureStore?.setItemAsync && secureStore?.getItemAsync && secureStore?.deleteItemAsync);
      },
      async setItemAsync(key, value) {
        return secureStore.setItemAsync(namespacedKey(key), value, { keychainAccessible: secureStore.ALWAYS_THIS_DEVICE_ONLY });
      },
      async getItemAsync(key) {
        return secureStore.getItemAsync(namespacedKey(key));
      },
      async deleteItemAsync(key) {
        return secureStore.deleteItemAsync(namespacedKey(key));
      }
    }),
    createStorageCandidate('async-storage', {
      isAvailable: () => {
        if (!nativeRuntime && !asyncStorageAdapter) {
          return false;
        }

        return Boolean(asyncStorage?.setItem && asyncStorage?.getItem && asyncStorage?.removeItem);
      },
      async setItemAsync(key, value) {
        return asyncStorage.setItem(namespacedKey(key), value);
      },
      async getItemAsync(key) {
        return asyncStorage.getItem(namespacedKey(key));
      },
      async deleteItemAsync(key) {
        return asyncStorage.removeItem(namespacedKey(key));
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

  let active;
  if (inTestEnv && !hasInjectedStorageAdapter) {
    active = candidates[candidates.length - 1];
    logger.debug('Persistence provider forced to memory in test environment');
  } else {
    active = candidates.find((candidate) => {
      try {
        return candidate.isAvailable();
      } catch (error) {
        logger.debug(`Storage candidate ${candidate.name} failed availability check`, { error: error?.message });
        return false;
      }
    });
  }

  if (!active) {
    active = candidates[candidates.length - 1];
  }

  logger.info('Persistence provider selected', { mode: active.name });

  const safeCall = async (fnName, key, value) => {
    try {
      return await active[fnName](key, value);
    } catch (error) {
      if (active.name === 'memory-mock') {
        logger.error(`Persistence provider ${active.name} failed for ${fnName}`, { key: namespacedKey(key), error: error?.message });
      } else {
        logger.warn(`Persistence provider ${active.name} failed for ${fnName}`, { key: namespacedKey(key), error: error?.message });
        logger.info('Falling back to in-memory persistence after failure', { previousMode: active.name });
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
    },
    async multiGetAsync(keys = []) {
      try {
        const entries = await Promise.all(
          (Array.isArray(keys) ? keys : []).map(async (key) => [key, await safeCall('getItemAsync', key)])
        );
        return entries;
      } catch (error) {
        logger.error('Persistence provider failed for multiGetAsync', { error: error?.message });
        return [];
      }
    },
    async multiSetAsync(entries = []) {
      try {
        await Promise.all(
          (Array.isArray(entries) ? entries : []).map(([key, value]) => safeCall('setItemAsync', key, value))
        );
        return true;
      } catch (error) {
        logger.error('Persistence provider failed for multiSetAsync', { error: error?.message });
        return false;
      }
    },
    async multiDeleteAsync(keys = []) {
      try {
        await Promise.all((Array.isArray(keys) ? keys : []).map((key) => safeCall('deleteItemAsync', key)));
        return true;
      } catch (error) {
        logger.error('Persistence provider failed for multiDeleteAsync', { error: error?.message });
        return false;
      }
    }
  };
};

module.exports = {
  createPersistenceProvider,
  default: createPersistenceProvider,
};
