import { useEffect, useState } from 'react';
import driverTourPackFeatureFlagService from '../services/driverTourPackFeatureFlag';

const DISABLED = Object.freeze({ enabled: false, loading: false, reason: 'DISABLED' });
const TESTFLIGHT_ELIGIBLE = process.env.EXPO_PUBLIC_DRIVER_TOUR_PACK_TESTFLIGHT === 'true';

export default function useDriverTourPackFeatureFlag(driverId, { service = driverTourPackFeatureFlagService } = {}) {
  const [state, setState] = useState(driverId ? { ...DISABLED, loading: true } : DISABLED);

  useEffect(() => {
    if (!driverId) {
      setState(DISABLED);
      return undefined;
    }
    setState({ enabled: false, loading: true, reason: 'CHECKING' });
    return service.subscribe(
      driverId,
      (next) => setState({ ...DISABLED, ...next }),
      () => setState({ enabled: false, loading: false, reason: 'UNAVAILABLE' }),
      { testflightEligible: TESTFLIGHT_ELIGIBLE },
    );
  }, [driverId, service]);

  return state;
}

export { TESTFLIGHT_ELIGIBLE };
