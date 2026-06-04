const isDevelopmentRuntime = () => (
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
);

const loadOptionalService = ({
  modulePath,
  loadModule,
  serviceLabel,
  logger,
  isTestEnv = process.env.NODE_ENV === 'test',
  shouldLogWhenUnavailable = false,
}) => {
  const label = serviceLabel || 'Optional service';

  try {
    if (typeof loadModule !== 'function') {
      throw new Error('Optional service loader requires a loadModule function');
    }

    return loadModule();
  } catch (error) {
    const message = error?.message || String(error);
    const shouldLog = !isTestEnv && shouldLogWhenUnavailable;

    if (shouldLog && logger?.warn) {
      logger.warn(label, 'Optional service unavailable', { modulePath, error: message });
    } else if (shouldLog && isDevelopmentRuntime()) {
      console.warn(`${label} unavailable:`, message);
    }

    return null;
  }
};

module.exports = { loadOptionalService };
