import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { driverTracking } from '../services/driver-tracking/driverTrackingRuntime';
import { normalizeTrackingScope } from '../services/driver-tracking/trackingIntent';

export default function useDriverTracking(sessionScope, { initializing = false, logoutState = 'idle', expiresAtMs = sessionScope?.expiresAtMs } = {}) {
  const scope = useMemo(() => !initializing && logoutState === 'idle' && sessionScope?.role === 'driver' && expiresAtMs
    ? normalizeTrackingScope({ ...sessionScope, expiresAtMs }) : null, [expiresAtMs, initializing, logoutState, sessionScope]);
  const latest = useRef(scope); latest.current = scope;
  const status = useSyncExternalStore(driverTracking.subscribe, driverTracking.getSnapshot, driverTracking.getSnapshot);
  useEffect(() => {
    driverTracking.recover().catch(() => driverTracking.stop({ reason: 'recovery_error' }).catch(() => {}));
    const check = () => driverTracking.checkCurrent().catch(() => {});
    const appState = AppState.addEventListener('change', state => { if (state === 'active') check(); });
    const timer = setInterval(check, 30_000);
    return () => { appState.remove(); clearInterval(timer); driverTracking.setScope(null).catch(() => {}); };
  }, []);
  useEffect(() => { driverTracking.setScope(scope).catch(() => {}); }, [scope]);
  return { ...status, canStart: Boolean(scope),
    purgeScope: driverTracking.purgeScope,
    start: () => driverTracking.start({ scope: latest.current, disclosureAccepted: true }),
    stop: () => driverTracking.stop().catch(() => ({ success: false, reason: 'STOP_PENDING' })) };
}
