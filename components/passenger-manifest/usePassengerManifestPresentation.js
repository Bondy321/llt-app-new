import { useMemo } from 'react';

import { MANIFEST_STATUS } from '../../services/bookingServiceRealtime';
import { pickupTimeToMinutes } from '../../services/pickupTimeParser';
import { buildBookingLeadPhoneIndex, normalizeBookingReference } from '../../utils/bookingLeadPhone';
import { HEADER_WIDGETS_VISIBLE } from './passengerManifestPresentation';

const priorityRank = (status) => {
  if (status === MANIFEST_STATUS.PENDING || status === MANIFEST_STATUS.PARTIAL) return 0;
  if (status === MANIFEST_STATUS.BOARDED) return 1;
  return 2;
};

export const computeStats = (bookings = []) => bookings.reduce((acc, booking) => {
  const paxCount = booking.passengerNames?.length || 0;
  acc.totalBookings += 1;
  acc.totalPax += paxCount;
  if (booking.hasPassengerStatuses && Array.isArray(booking.passengerStatus) && booking.passengerStatus.length > 0) {
    booking.passengerStatus.forEach((status) => {
      if (status === MANIFEST_STATUS.BOARDED) acc.checkedIn += 1;
      if (status === MANIFEST_STATUS.NO_SHOW) acc.noShows += 1;
    });
  } else {
    if (booking.status === MANIFEST_STATUS.BOARDED) acc.checkedIn += paxCount;
    if (booking.status === MANIFEST_STATUS.NO_SHOW) acc.noShows += paxCount;
  }
  return acc;
}, { totalBookings: 0, totalPax: 0, checkedIn: 0, noShows: 0 });

const matchesSearch = (booking, query) => {
  if (!query) return true;
  const queryValue = query.toLowerCase();
  const names = (booking.passengerNames || []).join(' ').toLowerCase();
  const location = String(booking.pickupLocation || '').toLowerCase();
  return booking.id.toLowerCase().includes(queryValue)
    || names.includes(queryValue)
    || location.includes(queryValue);
};

export const getUnresolvedBookingCount = (bookings = []) => bookings
  .filter((booking) => priorityRank(booking.status) === 0)
  .length;

export default function usePassengerManifestPresentation({
  driverTourPack,
  manifestData,
  queueStats,
  searchQuery,
  selectedBooking,
  statusFilter,
  tourId,
}) {
  const filteredBookings = useMemo(() => {
    const query = searchQuery.trim();
    return manifestData.bookings.filter((booking) => {
      const statusPass = statusFilter === 'ALL' || booking.status === statusFilter;
      return statusPass && matchesSearch(booking, query);
    });
  }, [manifestData.bookings, searchQuery, statusFilter]);

  const sortedFilteredBookings = useMemo(() => [...filteredBookings].sort((a, b) => {
    const priorityDelta = priorityRank(a.status) - priorityRank(b.status);
    if (priorityDelta !== 0) return priorityDelta;
    const pickupDelta = pickupTimeToMinutes(a.pickupTime) - pickupTimeToMinutes(b.pickupTime);
    return pickupDelta !== 0 ? pickupDelta : a.id.localeCompare(b.id);
  }), [filteredBookings]);

  const sectionListData = useMemo(() => {
    const groups = new Map();
    sortedFilteredBookings.forEach((booking) => {
      const unresolved = priorityRank(booking.status) === 0;
      const pickupLabel = booking.pickupTime || 'TBA';
      const pickupLocation = String(booking.pickupLocation || '').trim() || 'Pickup point unavailable';
      const key = `${pickupLocation.toUpperCase()}__${pickupLabel.toUpperCase()}`;
      if (!groups.has(key)) groups.set(key, {
        title: `${pickupLocation} - ${pickupLabel}`,
        data: [],
        unresolved,
        pickupLabel,
        pickupLocation,
      });
      const group = groups.get(key);
      group.unresolved = group.unresolved || unresolved;
      group.data.push(booking);
    });
    return [...groups.values()].sort((a, b) => {
      if (a.unresolved !== b.unresolved) return a.unresolved ? -1 : 1;
      const pickupDelta = pickupTimeToMinutes(a.pickupLabel) - pickupTimeToMinutes(b.pickupLabel);
      return pickupDelta !== 0 ? pickupDelta : a.pickupLocation.localeCompare(b.pickupLocation);
    });
  }, [sortedFilteredBookings]);

  const totalStats = useMemo(() => computeStats(manifestData.bookings), [manifestData.bookings]);
  const filteredStats = useMemo(() => computeStats(filteredBookings), [filteredBookings]);
  const resolutionStats = useMemo(() => {
    const resolved = Math.max(filteredStats.checkedIn + filteredStats.noShows, 0);
    const total = Math.max(filteredStats.totalPax, 0);
    const unresolved = Math.max(total - resolved, 0);
    return { resolved, unresolved, total, completionPercent: total === 0 ? 0 : Math.round((resolved / total) * 100) };
  }, [filteredStats]);
  const nextPriorityBooking = useMemo(
    () => sortedFilteredBookings.find((booking) => priorityRank(booking.status) === 0) || null,
    [sortedFilteredBookings],
  );
  const bookingLeadPhones = useMemo(
    () => buildBookingLeadPhoneIndex(driverTourPack, tourId),
    [driverTourPack, tourId],
  );
  const selectedBookingPhone = selectedBooking
    ? bookingLeadPhones.get(normalizeBookingReference(selectedBooking.id))
    : null;
  const pendingQueueCount = queueStats.pending || 0;
  const syncingQueueCount = queueStats.syncing || 0;
  const failedQueueCount = queueStats.failed || 0;
  const activeQueueCount = pendingQueueCount + syncingQueueCount + failedQueueCount;

  return {
    activeQueueCount,
    failedQueueCount,
    isNarrowedView: searchQuery.trim().length > 0 || statusFilter !== 'ALL',
    nextPriorityBooking,
    queueDescriptor: syncingQueueCount > 0
      ? `${pendingQueueCount} pending - ${syncingQueueCount} syncing - ${failedQueueCount} failed`
      : `${pendingQueueCount} pending - ${failedQueueCount} failed`,
    resolutionStats,
    resultsDescriptor: `${sortedFilteredBookings.length} of ${manifestData.bookings.length} bookings`,
    sectionListData,
    selectedBookingPhone,
    showHeaderProgressRow: (HEADER_WIDGETS_VISIBLE.completion && resolutionStats.unresolved > 0)
      || (HEADER_WIDGETS_VISIBLE.syncStatus && activeQueueCount > 0),
    sortedFilteredBookings,
    totalStats,
    unresolvedDescriptor: `${resolutionStats.unresolved} unresolved`,
  };
}
