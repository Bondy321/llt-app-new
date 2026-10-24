'use strict';

// A decision deadline bounds credentials, transport and body parsing together.
// It cannot cancel a remote mutation already admitted by the server.
const withHttpRequestBoundary = async (operation, { timeoutMs = 15000, signal } = {}) => {
  const controller = new AbortController();
  let timer; let closed = false; let rejectDeadline;
  const failure = code => Object.assign(new Error(code), { code, retryable: true });
  const check = () => { if (closed || controller.signal.aborted) throw failure('REQUEST_CANCELLED'); };
  const cancel = () => { controller.abort(); rejectDeadline(failure('REQUEST_CANCELLED')); };
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(() => { controller.abort(); reject(failure('REQUEST_TIMEOUT')); },
      Number.isFinite(timeoutMs) ? Math.max(1, Math.min(60000, timeoutMs)) : 15000);
  });
  signal?.addEventListener('abort', cancel);
  if (signal?.aborted) cancel();
  try {
    return await Promise.race([deadline, Promise.resolve().then(() => {
      check(); return operation({ signal: controller.signal, check });
    }).then(result => { check(); return result; })]);
  } finally { closed = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
};
module.exports = { withHttpRequestBoundary };
