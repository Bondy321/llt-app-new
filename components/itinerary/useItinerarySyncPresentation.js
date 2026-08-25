import { useMemo } from 'react';

import offlineSyncService from '../../services/offlineSyncService';
import { parseTimestampMs } from '../../services/timeUtils';
import { buildItinerarySyncPresentation } from '../../utils/itinerarySyncPresentation';

export default function useItinerarySyncPresentation({
  checkingForUpdates,
  dataSource,
  errorMessage,
  freshnessNow,
  itinerary,
  lastSyncedAt,
  refreshing,
}) {
  const syncStatus = useMemo(() => buildItinerarySyncPresentation({
    source: dataSource,
    hasItinerary: Boolean(itinerary?.days?.length),
    checkingForUpdates,
    refreshing,
    errorMessage,
    freshness: offlineSyncService.getStalenessLabel(lastSyncedAt, freshnessNow),
  }), [checkingForUpdates, dataSource, errorMessage, freshnessNow, itinerary?.days?.length, lastSyncedAt, refreshing]);

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
