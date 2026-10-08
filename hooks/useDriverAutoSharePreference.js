import { useCallback, useEffect, useState } from 'react';
import logger, { maskIdentifier } from '../services/loggerService';

export default function useDriverAutoSharePreference({ persistenceRef, preferenceKey,
  driverId, generationRef, setStatus }) {
  const [preference, setPreference] = useState(null);
  const enabled = preference?.key === preferenceKey && preference?.driverId === driverId
    && preference.enabled === true;
  const setEnabled = useCallback(value => {
    setPreference({ key: preferenceKey, driverId, enabled: value });
  }, [preferenceKey, driverId]);
  useEffect(() => {
    let cancelled = false;
    const generation = generationRef.current;
    const isCurrent = () => !cancelled && generationRef.current === generation;
    const load = async () => {
      try {
        const stored = await persistenceRef.current.getItemAsync(preferenceKey);
        if (!isCurrent()) return;
        const enabled = stored === 'true';
        setEnabled(enabled);
        setStatus(enabled ? 'Waiting for the next in-app location share' : 'Auto-share is off');
        logger.info('DriverHomeScreen', 'Auto-share preference loaded', {
          driverId: maskIdentifier(driverId), enabled,
        });
      } catch (error) {
        if (!isCurrent()) return;
        setEnabled(false);
        setStatus('Auto-share is off');
        logger.warn('DriverHomeScreen', 'Auto-share preference load failed', {
          driverId: maskIdentifier(driverId), error: error?.message || String(error),
        });
      }
    };
    load();
    return () => { cancelled = true; };
  }, [preferenceKey, driverId, generationRef, persistenceRef, setEnabled, setStatus]);
  // A reused controller must never inherit another driver's enabled preference,
  // even for the render before its new asynchronous preference load completes.
  return { enabled, setEnabled };
}
