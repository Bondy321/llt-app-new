const DRIVER_ID = /^D-[A-Z0-9_-]{1,77}$/;
const GLOBAL_PATH = 'driver_tour_pack_feature_flags/global';
const DRIVER_PATH = 'driver_tour_pack_feature_flags/drivers';

const normalizeDriverId = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return DRIVER_ID.test(normalized) ? normalized : '';
};
const enabled = (value) => value === true;
const defaultDatabase = () => require('../firebase').realtimeDb;

function createDriverTourPackFeatureFlagService({ getDatabase = defaultDatabase } = {}) {
  const subscribe = (driverIdInput, onChange, onError) => {
    const driverId = normalizeDriverId(driverIdInput);
    const db = getDatabase?.();
    if (!driverId || !db?.ref) {
      onChange?.({ enabled: false, loading: false, reason: 'UNAVAILABLE' });
      return () => {};
    }

    const globalRef = db.ref(GLOBAL_PATH);
    const driverRef = db.ref(`${DRIVER_PATH}/${driverId}`);
    let active = true;
    let globalReady = false;
    let driverReady = false;
    let globalEnabled = false;
    let driverEnabled = false;
    const emit = () => {
      if (!active || !globalReady || !driverReady) return;
      onChange?.({
        enabled: globalEnabled || driverEnabled,
        loading: false,
        reason: globalEnabled ? 'GLOBAL_ENABLED' : driverEnabled ? 'DRIVER_ENABLED' : 'DISABLED',
      });
    };
    const failClosed = (error) => {
      if (!active) return;
      globalReady = true;
      driverReady = true;
      globalEnabled = false;
      driverEnabled = false;
      onChange?.({ enabled: false, loading: false, reason: 'UNAVAILABLE' });
      onError?.(error);
    };
    const onGlobal = (snapshot) => {
      globalReady = true;
      globalEnabled = enabled(snapshot?.val?.());
      emit();
    };
    const onDriver = (snapshot) => {
      driverReady = true;
      driverEnabled = enabled(snapshot?.val?.());
      emit();
    };

    globalRef.on('value', onGlobal, failClosed);
    driverRef.on('value', onDriver, failClosed);
    return () => {
      active = false;
      globalRef.off?.('value', onGlobal);
      driverRef.off?.('value', onDriver);
    };
  };

  return { subscribe };
}

const service = createDriverTourPackFeatureFlagService();
module.exports = {
  GLOBAL_PATH,
  DRIVER_PATH,
  normalizeDriverId,
  enabled,
  createDriverTourPackFeatureFlagService,
  ...service,
};
