const ITINERARY_DATA_SOURCE = Object.freeze({
  NONE: 'none',
  CACHE: 'cache',
  LIVE: 'live',
});

const buildItinerarySyncPresentation = ({
  source = ITINERARY_DATA_SOURCE.NONE,
  hasItinerary = false,
  checkingForUpdates = false,
  refreshing = false,
  errorMessage = '',
  freshness = { bucket: 'old', label: 'Not synced yet' },
} = {}) => {
  if (refreshing) {
    return {
      tone: 'fresh',
      icon: 'sync',
      label: 'Refreshing itinerary',
      detail: freshness.label === 'Not synced yet' ? 'Checking for updates' : freshness.label,
      showRetry: false,
    };
  }

  if (source === ITINERARY_DATA_SOURCE.CACHE) {
    return {
      tone: errorMessage ? 'warning' : (freshness.bucket === 'old' ? 'warning' : 'neutral'),
      icon: errorMessage ? 'cloud-alert' : 'cloud-clock-outline',
      label: 'Saved itinerary',
      detail: checkingForUpdates
        ? `${freshness.label} · Checking for newer changes`
        : errorMessage
          ? `${freshness.label} · Live changes unavailable`
          : `${freshness.label} · Saved on this device`,
      showRetry: Boolean(errorMessage),
    };
  }

  if (errorMessage) {
    return {
      tone: 'critical',
      icon: 'cloud-off-outline',
      label: hasItinerary ? 'Live updates unavailable' : 'Itinerary unavailable',
      detail: hasItinerary ? 'Showing the last loaded version' : 'Check your connection and try again',
      showRetry: true,
    };
  }

  if (checkingForUpdates) {
    return {
      tone: 'neutral',
      icon: 'cloud-sync-outline',
      label: 'Checking itinerary',
      detail: 'Looking for the latest published version',
      showRetry: false,
    };
  }

  if (source === ITINERARY_DATA_SOURCE.LIVE) {
    return {
      tone: 'fresh',
      icon: 'cloud-check-outline',
      label: 'Live itinerary',
      detail: `${freshness.label} · Changes update automatically`,
      showRetry: false,
    };
  }

  return {
    tone: 'neutral',
    icon: 'cloud-outline',
    label: 'Itinerary not loaded',
    detail: 'Pull down to check again',
    showRetry: false,
  };
};

module.exports = {
  ITINERARY_DATA_SOURCE,
  buildItinerarySyncPresentation,
};
