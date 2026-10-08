// A timed-out SDK promise may still settle later. Callers must fence its result;
// this helper releases the current task without queuing another location write.
export const withTrackingTimeout = (operation, timeoutMs = 10_000) => {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('TRACKING_NETWORK_ERROR');
        error.code = error.message;
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
};
