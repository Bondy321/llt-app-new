const createLazyRealtimeDbResolver = ({ loadFirebaseModule, onLoadError } = {}) => {
  if (typeof loadFirebaseModule !== 'function') {
    throw new TypeError('loadFirebaseModule must be a function');
  }

  let cachedRealtimeDb = null;

  return () => {
    if (cachedRealtimeDb) {
      return cachedRealtimeDb;
    }

    try {
      const firebaseModule = loadFirebaseModule();
      const resolvedRealtimeDb = firebaseModule?.realtimeDb || null;
      if (resolvedRealtimeDb) {
        cachedRealtimeDb = resolvedRealtimeDb;
      }
      return resolvedRealtimeDb;
    } catch (error) {
      if (typeof onLoadError === 'function') {
        onLoadError(error);
      }
      return null;
    }
  };
};

module.exports = {
  createLazyRealtimeDbResolver,
};
