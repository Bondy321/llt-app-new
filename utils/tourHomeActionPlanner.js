const { MANIFEST_STATUS } = require('../services/bookingServiceRealtime');

const ACTION_IDS = {
  MAP: 'Map',
  CHAT: 'Chat',
  ITINERARY: 'Itinerary',
  PHOTOS: 'GroupPhotobook',
};

const buildTourHomeActionPlan = ({ manifestStatus, pickupCountdown, driverLocationActive }) => {
  const isNoShow = manifestStatus === MANIFEST_STATUS.NO_SHOW;
  const pickupSoon = pickupCountdown?.mode === 'countdown' && pickupCountdown.totalMinutesLeft <= 120;

  if (isNoShow) {
    return {
      title: 'Reconnect with your driver now',
      subtitle: 'You were marked as missing. Call or message your driver immediately.',
      primaryActionId: ACTION_IDS.CHAT,
      orderedActionIds: [ACTION_IDS.CHAT, ACTION_IDS.MAP, ACTION_IDS.ITINERARY, ACTION_IDS.PHOTOS],
    };
  }

  if (pickupSoon) {
    return {
      title: 'Pickup is coming up soon',
      subtitle: driverLocationActive
        ? 'Track your driver live and head to the pickup point.'
        : 'Open the map now so you are ready at your pickup point.',
      primaryActionId: ACTION_IDS.MAP,
      orderedActionIds: [ACTION_IDS.MAP, ACTION_IDS.CHAT, ACTION_IDS.ITINERARY, ACTION_IDS.PHOTOS],
    };
  }

  return {
    title: 'Plan your next step',
    subtitle: 'Check updates, review your itinerary, and stay in touch with your group.',
    primaryActionId: ACTION_IDS.ITINERARY,
    orderedActionIds: [ACTION_IDS.ITINERARY, ACTION_IDS.CHAT, ACTION_IDS.MAP, ACTION_IDS.PHOTOS],
  };
};

module.exports = {
  buildTourHomeActionPlan,
  ACTION_IDS,
};
