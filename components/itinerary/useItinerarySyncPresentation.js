import { useMemo } from 'react';

import offlineSyncService from '../../services/offlineSyncService';
import { parseTimestampMs } from '../../services/timeUtils';
import { buildItinerarySyncPresentation } from '../../utils/itinerarySyncPresentation';
import { getTripPartPresentation } from '../tour-home/TripDataStatus';

export default function useItinerarySyncPresentation({
  checkingForUpdates,
  dataSource,
  errorMessage,
  freshnessNow,
  itinerary,
  lastSyncedAt,
  refreshing,
  passengerTripNowMs,
  passengerTripPart,
}) {
  const syncStatus = useMemo(() => {
    if (passengerTripPart) {
      const presentation = getTripPartPresentation(passengerTripPart, passengerTripNowMs);
      const hasItinerary = Boolean(itinerary?.days?.length);
      return {
        tone: passengerTripPart.status === 'error' ? (hasItinerary ? 'warning' : 'critical') : 'neutral',
        icon: presentation.icon,
        label: passengerTripPart.status === 'empty' || (!passengerTripPart.data && passengerTripPart.version)
          ? 'No published itinerary'
          : passengerTripPart.status === 'error'
            ? (hasItinerary ? 'Saved itinerary' : 'Itinerary unavailable')
            : passengerTripPart.status === 'checking'
              ? 'Checking itinerary'
              : (passengerTripPart.persisted ? 'Saved itinerary' : (passengerTripPart.checkedAtMs ? 'Checked itinerary' : 'Loaded itinerary')),
        detail: refreshing ? 'Refreshing itinerary' : presentation.text,
        showRetry: passengerTripPart.status === 'error',
      };
    }
    return buildItinerarySyncPresentation({
      source: dataSource,
      hasItinerary: Boolean(itinerary?.days?.length),
      checkingForUpdates,
      refreshing,
      errorMessage,
      freshness: offlineSyncService.getStalenessLabel(lastSyncedAt, freshnessNow),
    });
  }, [checkingForUpdates, dataSource, errorMessage, freshnessNow, itinerary?.days?.length, lastSyncedAt,
    passengerTripNowMs, passengerTripPart, refreshing]);

  const syncAccessibilityLabel = useMemo(() => {
    const parsedLastSync = parseTimestampMs(lastSyncedAt);
    const exactLastSync = Number.isFinite(parsedLastSync)
      ? `Last confirmed ${new Date(parsedLastSync).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })}`
      : '';
    return [syncStatus.label, syncStatus.detail, exactLastSync].filter(Boolean).join('. ');
  }, [lastSyncedAt, syncStatus.detail, syncStatus.label]);

  return { syncAccessibilityLabel, syncStatus };
}
