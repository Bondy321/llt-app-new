// Hermes does not promise the browser atob/TextDecoder globals. Decode the
// bounded base64 payload to UTF-8 using ECMAScript primitives instead.
const decodeBase64Utf8 = encoded => {
  if (typeof encoded !== 'string' || encoded.length > 16384
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('APP_CHECK_TOKEN_INVALID');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let accumulator = 0;
  let bits = 0;
  const escapedBytes = [];
  for (const character of encoded.replace(/=+$/, '')) {
    accumulator = (accumulator << 6) | alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      escapedBytes.push(`%${((accumulator >>> bits) & 255).toString(16).padStart(2, '0')}`);
    }
  }
  if (bits && (accumulator & ((1 << bits) - 1)) !== 0) throw new Error('APP_CHECK_TOKEN_INVALID');
  return decodeURIComponent(escapedBytes.join(''));
};

// The payload supplies expiry only. Firebase verifies the signature and app
// identity on the server; decoding here never establishes authorisation.
export const tokenWithExpiry = (token, now = Date.now(), decode = decodeBase64Utf8) => {
  if (typeof token !== 'string' || token.length > 16384 || typeof decode !== 'function') {
    throw new Error('APP_CHECK_TOKEN_INVALID');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error('APP_CHECK_TOKEN_INVALID');
  let expiry;
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    expiry = JSON.parse(decode(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))).exp;
  } catch {
    throw new Error('APP_CHECK_TOKEN_INVALID');
  }
  if (!Number.isSafeInteger(expiry) || !Number.isSafeInteger(expiry * 1000) || expiry * 1000 <= now) throw new Error('APP_CHECK_TOKEN_EXPIRED');
  return { token, expireTimeMillis: expiry * 1000 };
};
