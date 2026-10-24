import { auth } from '../firebase';
import { getAdminRequestHeaders } from './adminRequestHeaders';
import { boundedRequest } from './boundedRequest';

export async function adminHttpRequest(endpoint, body, { timeoutMs = 20000, fetchFn = fetch } = {}) {
  const user = auth.currentUser;
  const controller = new AbortController();
  let closed = false;
  const check = () => {
    if (closed || controller.signal.aborted) throw new Error('Request no longer active.');
    if (!user || auth.currentUser !== user) throw new Error('Your admin account changed. Retry from the current session.');
  };
  try {
    return await boundedRequest(async () => {
      check();
      const headers = await getAdminRequestHeaders();
      check();
      const response = await fetchFn(endpoint, { method: 'POST', headers, body: JSON.stringify(body || {}), signal: controller.signal });
      check();
      const payload = await response.json().catch(() => null);
      check();
      return { response, payload };
    }, timeoutMs);
  } catch (error) {
    if (error.message === 'The request did not finish. Check your connection and retry.') {
      throw Object.assign(new Error('The result could not be confirmed. The operation may still have completed; check the current record before retrying.'), { code: 'REQUEST_TIMEOUT' });
    }
    throw error;
  } finally { closed = true; controller.abort(); }
}
