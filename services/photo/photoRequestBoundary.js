'use strict';
const requestError = (code, message) => Object.assign(new Error(message), { code, retryable: code === 'PHOTO_REQUEST_TIMEOUT' });

// One deadline includes local file reads, credentials, transport and response body.
// Aborting transport cannot undo a server mutation; callers retain idempotency keys.
const withPhotoRequestBoundary = async ({ authInstance, fetchFn, timeoutMs = 15000 }, operation) => {
  const user = authInstance?.currentUser;
  const deadlineMs = Number.isFinite(timeoutMs) ? Math.min(60000, Math.max(1, timeoutMs)) : 15000;
  const controller = new AbortController();
  let closed = false; let expired = false; let timer;
  const check = () => {
    if (expired || closed) throw requestError('PHOTO_REQUEST_TIMEOUT', 'Photo request timed out. Please retry; the previous request may still have completed.');
    if (!user) throw requestError('PHOTO_NOT_AUTHENTICATED', 'Authenticated user required for photo upload');
    if (authInstance.currentUser !== user) throw requestError('PHOTO_IDENTITY_CHANGED', 'The signed-in account changed. Please try again.');
  };
  const boundary = { user, check, signal: controller.signal,
    fetch: async (...args) => {
      check();
      const response = await fetchFn(args[0], { ...args[1], signal: controller.signal });
      check();
      return new Proxy(response, { get(target, key) {
        if (key === 'json' || key === 'blob') return async (...bodyArgs) => {
          check(); const value = await target[key](...bodyArgs);
          try { check(); } catch (error) { if (key === 'blob') value?.close?.(); throw error; }
          return value;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
  try {
    check();
    return await Promise.race([
      Promise.resolve().then(() => operation(boundary)).then(value => { check(); return value; }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        expired = true; controller.abort();
        reject(requestError('PHOTO_REQUEST_TIMEOUT', 'Photo request timed out. Please retry; the previous request may still have completed.'));
      }, deadlineMs); }),
    ]);
  } catch (error) {
    if (expired) throw requestError('PHOTO_REQUEST_TIMEOUT', 'Photo request timed out. Please retry; the previous request may still have completed.');
    throw error;
  } finally { closed = true; clearTimeout(timer); controller.abort(); }
};
module.exports = { withPhotoRequestBoundary };
