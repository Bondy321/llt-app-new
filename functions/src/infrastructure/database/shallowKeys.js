'use strict';

const { isValidFirebaseKey } = require('./firebaseKey');
const { getRuntimeEnvironment } = require('../../config/runtimeConfig');
const failure = () => Object.assign(new Error('Bounded database key read failed'), { code: 'DATABASE_KEYS_UNAVAILABLE' });

const buildShallowUrl = ({ databaseURL, path, emulatorHost }) => {
  const source = new URL(databaseURL);
  if (source.protocol !== 'https:' || !/^[a-z0-9-]+\.(?:firebaseio\.com|(?:[a-z0-9-]+\.)?firebasedatabase\.app)$/.test(source.hostname)
    || source.username || source.password || source.search || source.hash || !['', '/'].includes(source.pathname)) throw failure();
  const parts = path.split('/');
  if (!parts.length || !parts.every(isValidFirebaseKey)) throw failure();
  let target = new URL(source.origin);
  if (emulatorHost) {
    if (!/^127\.0\.0\.1:\d+$/.test(emulatorHost) || !source.hostname.startsWith('demo-')) throw failure();
    target = new URL(`http://${emulatorHost}`);
    target.searchParams.set('ns', source.hostname.split('.')[0]);
  }
  target.pathname = `/${parts.map(encodeURIComponent).join('/')}.json`;
  target.searchParams.set('shallow', 'true');
  return target;
};

// RTDB shallow REST is the supported way to read directory keys without loading
// each owner's complete photo history. Credential values never enter URLs/logs.
const readBoundedShallowKeys = async ({ db, path, maxBytes = 262144, maxKeys = 2000,
  timeoutMs = 10000, fetchImpl = fetch, env = getRuntimeEnvironment() }) => {
  const emulatorHost = env.FIREBASE_DATABASE_EMULATOR_HOST;
  const url = buildShallowUrl({ databaseURL: db.app?.options?.databaseURL, path, emulatorHost });
  const controller = new AbortController();
  let rejectTimeout;
  const timedOut = new Promise((_resolve, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(failure()); }, timeoutMs);
  try {
    const request = async () => {
      const token = emulatorHost ? 'owner' : (await db.app.options.credential.getAccessToken()).access_token;
      if (typeof token !== 'string' || !token) throw failure();
      controller.signal.throwIfAborted();
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal, redirect: 'error' });
      if (!response.ok || !response.body) throw failure();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) { controller.abort(); throw failure(); }
        chunks.push(Buffer.from(chunk));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value === null) return [];
      if (typeof value !== 'object' || Array.isArray(value)) throw failure();
      const keys = Object.keys(value);
      if (keys.length > maxKeys || !keys.every(key => isValidFirebaseKey(key) && value[key] === true)) throw failure();
      return keys.sort();
    };
    return await Promise.race([request(), timedOut]);
  } catch { throw failure(); }
  finally { clearTimeout(timer); }
};

module.exports = { readBoundedShallowKeys, buildShallowUrl };
