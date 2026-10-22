import { useCallback, useRef, useState } from 'react';

// Authority decisions can run between a state setter and React's next render.
// Keep the lifecycle fence synchronous while React owns the displayed status.
export default function useLogoutStatus() {
  const [logoutStatus, setStatus] = useState({ state: 'idle', error: null, diagnostic: null });
  const logoutStatusRef = useRef(logoutStatus);
  const setLogoutStatus = useCallback(update => {
    const next = typeof update === 'function' ? update(logoutStatusRef.current) : update;
    logoutStatusRef.current = next;
    setStatus(next);
  }, []);
  return { logoutStatus, logoutStatusRef, setLogoutStatus };
}
