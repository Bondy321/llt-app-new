// services/persistenceProvider.js
// Centralized persistence with an explicit storage policy per data class.
let SecureStore;
let AsyncStorage;

try {
  SecureStore = require('expo-secure-store');
} catch (_error) {
  SecureStore = null;
}

try {
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
} catch (_error) {
  AsyncStorage = null;
}

const IS_DEV_RUNTIME =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

const writeDevConsole = (method, ...args) => {
  if (IS_DEV_RUNTIME && typeof console !== 'undefined' && typeof console[method] === 'function') {
    console[method](...args);
  }
};

const defaultLogger = {
  debug: (msg, data) => writeDevConsole('log', `[Persistence][debug] ${msg}`, data || ''),
  info: (msg, data) => writeDevConsole('log', `[Persistence][info] ${msg}`, data || ''),
  warn: (msg, data) => writeDevConsole('warn', `[Persistence][warn] ${msg}`, data || ''),
  error: (msg, data) => writeDevConsole('error', `[Persistence][error] ${msg}`, data || ''),
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

  // React Native Web deliberately installs throwing accessors for some bridge
  // globals. Detect an actual browser before touching any native-only globals so
  // a harmless capability check can never prevent the web bundle from starting.
  if (globalObj?.window && globalObj?.document) {
    return false;
  }

  return Boolean(
    navigatorObj?.product === 'ReactNative'
    || globalObj?.nativeCallSyncHook
    || globalObj?.__fbBatchedBridgeConfig
    || globalObj?.HermesInternal
  );
};

const isBrowserRuntime = (runtime = {}) => {
  if (typeof runtime.isWeb === 'boolean') {
    return runtime.isWeb;
  }

  const globalObj = runtime.globalObject || globalThis;
  return Boolean(globalObj?.window && globalObj?.document);
};

const resolveSecureStoreOptions = (secureStore) => {
  const keychainAccessible =
    secureStore?.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    ?? secureStore?.WHEN_UNLOCKED
    ?? null;

  return keychainAccessible ? { keychainAccessible } : undefined;
};

const createPersistenceProvider = ({
  namespace = 'LLT',
  logger = defaultLogger,
  secureStoreAdapter,
  asyncStorageAdapter,
  preferredStorage = 'secure-store',
  allowMemoryFallback = true,
  migrateFrom = [],
  runtime = {},
} = {}) => {
  const namespacedKey = (key) => `${namespace}_${key}`;
  const secureStore = secureStoreAdapter || SecureStore;
  const asyncStorage = asyncStorageAdapter || AsyncStorage;
  const secureStoreOptions = resolveSecureStoreOptions(secureStore);
  const hasInjectedStorageAdapter = Boolean(secureStoreAdapter || asyncStorageAdapter);
  const inTestEnv = (runtime.nodeEnv || process?.env?.NODE_ENV) === 'test';
  const nativeRuntime = isReactNativeRuntime(runtime);
  const browserRuntime = isBrowserRuntime(runtime);

  const candidates = [
    createStorageCandidate('secure-store', {
      isAvailable: () => {
        if (!nativeRuntime && !secureStoreAdapter) {
          return false;
        }

        return Boolean(secureStore?.setItemAsync && secureStore?.getItemAsync && secureStore?.deleteItemAsync);
      },
      async setItemAsync(key, value) {
        return secureStore.setItemAsync(namespacedKey(key), value, secureStoreOptions);
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
        // AsyncStorage's web implementation is backed by browser localStorage,
        // so it is a durable adapter there as well as on native devices.
        if (!nativeRuntime && !browserRuntime && !asyncStorageAdapter) {
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

  const candidateByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  const normalizedPreferredStorage = candidateByName.has(preferredStorage)
    ? preferredStorage
    : 'secure-store';
  const fallbackNames = normalizedPreferredStorage === 'secure-store'
    ? ['async-storage']
    : [];
  if (allowMemoryFallback) fallbackNames.push('memory-mock');
  const selectionOrder = [...new Set([normalizedPreferredStorage, ...fallbackNames])]
    .map((name) => candidateByName.get(name))
    .filter(Boolean);
  const migrationCandidates = [...new Set(Array.isArray(migrateFrom) ? migrateFrom : [])]
    .filter((name) => name !== normalizedPreferredStorage)
    .map((name) => candidateByName.get(name))
    .filter(Boolean);

  let active;
  if (inTestEnv && !hasInjectedStorageAdapter) {
    active = candidates[candidates.length - 1];
    logger.debug('Persistence provider forced to memory in test environment');
  } else {
    active = selectionOrder.find((candidate) => {
      try {
        return candidate.isAvailable();
      } catch (error) {
        logger.debug(`Storage candidate ${candidate.name} failed availability check`, { error: error?.message });
        return false;
      }
    });
  }

  if (!active) {
    if (!allowMemoryFallback) {
      throw new Error(`No durable persistence adapter is available for ${namespace}`);
    }
    active = candidateByName.get('memory-mock');
  }

  logger.info('Persistence provider selected', { mode: active.name });

  let lastError = null;
  let degraded = active.name === 'memory-mock' && !inTestEnv;

  const isAvailable = (candidate) => {
    try {
      return candidate?.isAvailable?.() === true;
    } catch (error) {
      logger.debug(`Storage candidate ${candidate?.name || 'unknown'} failed availability check`, {
        error: error?.message,
      });
      return false;
    }
  };

  const resolveFallback = () => {
    const activeIndex = selectionOrder.findIndex((candidate) => candidate.name === active.name);
    return selectionOrder
      .slice(Math.max(0, activeIndex + 1))
      .find((candidate) => candidate.name !== 'memory-mock' || allowMemoryFallback)
      || null;
  };

  const safeCall = async (fnName, key, value) => {
    try {
      const result = await active[fnName](key, value);

      if (fnName === 'getItemAsync' && result == null && active.name === normalizedPreferredStorage) {
        for (const legacyCandidate of migrationCandidates) {
          if (!isAvailable(legacyCandidate)) continue;
          try {
            const legacyValue = await legacyCandidate.getItemAsync(key);
            if (legacyValue == null) continue;
            await active.setItemAsync(key, legacyValue);
            await legacyCandidate.deleteItemAsync(key);
            logger.info('Migrated persisted value to preferred storage', {
              key: namespacedKey(key),
              from: legacyCandidate.name,
              to: active.name,
            });
            return legacyValue;
          } catch (migrationError) {
            lastError = migrationError;
            logger.warn('Persistence migration failed', {
              key: namespacedKey(key),
              from: legacyCandidate.name,
              to: active.name,
              error: migrationError?.message,
            });
          }
        }
      }

      return result;
    } catch (error) {
      lastError = error;
      degraded = true;
      logger.warn(`Persistence provider ${active.name} failed for ${fnName}`, {
        key: namespacedKey(key),
        error: error?.message,
      });

      const fallback = resolveFallback();
      if (fallback && isAvailable(fallback)) {
        const previousMode = active.name;
        active = fallback;
        logger.warn('Persistence provider switched after failure', {
          previousMode,
          nextMode: active.name,
        });
        return active[fnName](key, value);
      }

      const persistenceError = new Error(`Durable persistence failed for ${namespace}`);
      persistenceError.code = 'PERSISTENCE_UNAVAILABLE';
      persistenceError.storageMode = active.name;
      persistenceError.cause = error;
      throw persistenceError;
    }
  };

  return {
    get mode() {
      return active.name;
    },
    get health() {
      return {
        mode: active.name,
        degraded,
        durable: active.name !== 'memory-mock',
        lastError: lastError?.message || null,
      };
    },
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
  isBrowserRuntime,
  isReactNativeRuntime,
  default: createPersistenceProvider,
};
