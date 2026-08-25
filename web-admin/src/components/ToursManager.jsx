/**
 * Tours Manager Component
 *
 * A comprehensive tour management system that integrates with Firebase Realtime Database.
 * Matches the existing Firebase tour data structure.
 *
 * FIREBASE DATA STRUCTURE:
 * ========================
 * tours/{tourId}:
 *   - name: string
 *   - tourCode: string (e.g., "5209L 16")
 *   - days: number
 *   - startDate: string (DD/MM/YYYY)
 *   - endDate: string (DD/MM/YYYY)
 *   - isActive: boolean
 *   - driverName: string ("TBA" or driver name)
 *   - driverPhone: string
 *   - maxParticipants: number
 *   - currentParticipants: number
 *   - pickupPoints: [{location, time}]
 *   - itinerary: {title, days: [{day, title, activities: [{description, time}]}]}
 *
 * HOW TO ADD A NEW TOUR:
 * =====================
 * Method 1: Click "Add Tour" button to open the creation modal
 * Method 2: Use "Quick Create" with pre-defined templates
 * Method 3: Import tours from CSV file
 */

import { useState, useEffect, useMemo } from 'react';
import ToursManagerView from '../features/tours/presentation/ToursManagerView';
import { useSearchParams } from 'react-router-dom';
import { getAdminDatabase } from '../shared/runtime/adminRuntime';
import { notifications } from '@mantine/notifications';
import { Text, Stack, Loader, Center } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { duplicateTour } from '../services/tourService';
import { parseUKDateStrict, parseISODateStrict } from '../utils/dateUtils';
import { buildTourPackCoverage, subscribeToDriverTourPackAdminStatuses } from '../services/driverTourPackAdminStatusService';
import { buildDriverTourPackOperationsByTour, departureKeyForTour, subscribeToDriverTourPackOperations, updateDriverTourPackIssueStatus } from '../services/driverTourPackOperationsService';
import { fetchTourByExactId, subscribeToDriverDirectory, subscribeToTourWindow } from '../services/adminDirectoryService';
const db = getAdminDatabase();
const getTodayAtNoon = () => {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return today;
};
const parseTourDate = value => {
  const ukParsed = parseUKDateStrict(value);
  if (ukParsed.success) return ukParsed.date;
  const isoParsed = parseISODateStrict(value);
  if (isoParsed.success) return isoParsed.date;
  return null;
};
const hasTourFinished = (tour, today = getTodayAtNoon()) => {
  const finishDate = parseTourDate(tour?.endDate || tour?.startDate);
  if (!finishDate) return false;
  return finishDate.getTime() < today.getTime();
};

// Tour Card Component for grid view
export default function ToursManager() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tourWindowTours, setTourWindowTours] = useState({});
  const [exactTourMatch, setExactTourMatch] = useState(null);
  const [drivers, setDrivers] = useState({});
  const [tourWindow, setTourWindow] = useState({
    atLimit: false,
    limit: 0
  });
  const [driverDirectoryAtLimit, setDriverDirectoryAtLimit] = useState(false);
  const [packStatusSnapshot, setPackStatusSnapshot] = useState({
    statuses: {},
    atLimit: false,
    limit: 0
  });
  const [packOperationsSnapshot, setPackOperationsSnapshot] = useState({
    progress: {},
    issues: {},
    atLimit: false,
    limit: 0
  });
  const [updatingIssueId, setUpdatingIssueId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('grid');
  const [currentPage, setCurrentPage] = useState(1);
  const [syncStatus, setSyncStatus] = useState('syncing');
  const itemsPerPage = 12;
  const allowedStatusParams = useMemo(() => new Set(['all', 'assigned', 'unassigned', 'active', 'inactive']), []);
  const allowedDateScopeParams = useMemo(() => new Set(['current', 'past', 'all']), []);
  const statusParam = searchParams.get('status');
  const filterStatus = statusParam && allowedStatusParams.has(statusParam) ? statusParam : 'all';
  const dateScopeParam = searchParams.get('dateScope');
  const filterDateScope = dateScopeParam && allowedDateScopeParams.has(dateScopeParam) ? dateScopeParam : 'current';
  const queryParam = searchParams.get('q') || '';
  const searchTerm = queryParam;
  const activeExactTourMatch = exactTourMatch?.query === queryParam.trim() ? exactTourMatch.match : null;
  const tours = useMemo(() => activeExactTourMatch ? {
    ...tourWindowTours,
    [activeExactTourMatch.tourId]: activeExactTourMatch.tour
  } : tourWindowTours, [tourWindowTours, activeExactTourMatch]);

  // Modal states
  const [createModalOpened, {
    open: openCreateModal,
    close: closeCreateModal
  }] = useDisclosure(false);
  const [editModalOpened, {
    open: openEditModal,
    close: closeEditModal
  }] = useDisclosure(false);
  const [deleteModalOpened, {
    open: openDeleteModal,
    close: closeDeleteModal
  }] = useDisclosure(false);
  const [detailsModalOpened, {
    open: openDetailsModal,
    close: closeDetailsModal
  }] = useDisclosure(false);
  const [importExportModalOpened, {
    open: openImportExportModal,
    close: closeImportExportModal
  }] = useDisclosure(false);
  const [addPassengerModalOpened, {
    open: openAddPassengerModal,
    close: closeAddPassengerModal
  }] = useDisclosure(false);
  const [helpExpanded, setHelpExpanded] = useState(false);

  // Selected tour for modals
  const [selectedTourId, setSelectedTourId] = useState(null);
  const handleFilterStatusChange = value => {
    // UI writes status changes back to URL, while preserving unrelated query params.
    const nextStatus = value || 'all';
    const currentStatusParam = searchParams.get('status') || 'all';
    setCurrentPage(1);
    if (currentStatusParam === nextStatus) {
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    if (nextStatus === 'all') {
      nextParams.delete('status');
    } else {
      nextParams.set('status', nextStatus);
    }
    setSearchParams(nextParams);
  };
  const handleDateScopeChange = value => {
    const nextDateScope = value || 'current';
    const currentDateScopeParam = searchParams.get('dateScope') || 'current';
    setCurrentPage(1);
    if (currentDateScopeParam === nextDateScope) {
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    if (nextDateScope === 'current') {
      nextParams.delete('dateScope');
    } else {
      nextParams.set('dateScope', nextDateScope);
    }
    setSearchParams(nextParams);
  };
  const handleSearchTermChange = value => {
    const nextSearchTerm = value || '';
    const currentQueryParam = searchParams.get('q') || '';
    setCurrentPage(1);
    if (currentQueryParam === nextSearchTerm.trim()) {
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    if (nextSearchTerm.trim()) {
      nextParams.set('q', nextSearchTerm.trim());
    } else {
      nextParams.delete('q');
    }
    setSearchParams(nextParams);
  };

  // Shared, bounded operational metadata subscriptions.
  useEffect(() => {
    const unsubPackStatuses = subscribeToDriverTourPackAdminStatuses(db, setPackStatusSnapshot, () => {
      setSyncStatus('error');
    });
    const unsubDrivers = subscribeToDriverDirectory(db, ({
      drivers: nextDrivers,
      atLimit
    }) => {
      setDrivers(nextDrivers);
      setDriverDirectoryAtLimit(atLimit);
      setLoading(false);
    }, error => {
      setLoading(false);
      setSyncStatus('error');
      notifications.show({
        title: 'Drivers unavailable',
        message: error?.message || 'Could not load driver assignments.',
        color: 'red'
      });
    });
    return () => {
      unsubDrivers();
      unsubPackStatuses();
    };
  }, []);
  useEffect(() => subscribeToTourWindow(db, {
    dateScope: filterDateScope
  }, ({
    tours: nextTours,
    atLimit,
    limit
  }) => {
    setTourWindowTours(nextTours);
    setTourWindow({
      atLimit,
      limit
    });
    setSyncStatus('connected');
  }, () => {
    setSyncStatus('error');
  }), [filterDateScope]);
  useEffect(() => {
    let cancelled = false;
    if (!queryParam.trim()) {
      return () => {
        cancelled = true;
      };
    }
    const requestedQuery = queryParam.trim();
    fetchTourByExactId(db, queryParam).then(match => {
      if (!cancelled) setExactTourMatch({
        query: requestedQuery,
        match
      });
    }).catch(() => {
      if (!cancelled) setExactTourMatch({
        query: requestedQuery,
        match: null
      });
    });
    return () => {
      cancelled = true;
    };
  }, [queryParam]);

  // Filter and search tours
  const filteredTours = useMemo(() => {
    const today = getTodayAtNoon();
    return Object.entries(tours).filter(([id, tour]) => {
      const matchesSearch = id.toLowerCase().includes(searchTerm.toLowerCase()) || tour.name && tour.name.toLowerCase().includes(searchTerm.toLowerCase()) || tour.tourCode && tour.tourCode.toLowerCase().includes(searchTerm.toLowerCase()) || tour.driverName && tour.driverName.toLowerCase().includes(searchTerm.toLowerCase());
      const isAssigned = tour.driverName && tour.driverName !== 'TBA';
      const matchesStatus = filterStatus === 'all' || filterStatus === 'assigned' && isAssigned || filterStatus === 'unassigned' && !isAssigned || filterStatus === 'active' && tour.isActive || filterStatus === 'inactive' && !tour.isActive;
      const isPastTour = hasTourFinished(tour, today);
      const isExactDeepLink = activeExactTourMatch?.tourId === id && queryParam.trim().length > 0;
      const matchesDateScope = isExactDeepLink || filterDateScope === 'all' || filterDateScope === 'past' && isPastTour || filterDateScope === 'current' && !isPastTour;
      return matchesSearch && matchesStatus && matchesDateScope;
    });
  }, [tours, searchTerm, filterStatus, filterDateScope, activeExactTourMatch, queryParam]);

  // Pagination
  const totalPages = Math.ceil(filteredTours.length / itemsPerPage);
  const paginatedTours = filteredTours.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  // Stats
  const totalTours = Object.keys(tours).length;
  const assignedTours = Object.values(tours).filter(t => t.driverName && t.driverName !== 'TBA').length;
  const unassignedTours = totalTours - assignedTours;
  const activeTours = Object.values(tours).filter(t => t.isActive).length;
  const totalParticipants = Object.values(tours).reduce((sum, t) => sum + (t.currentParticipants || 0), 0);
  const visibleDepartureKeys = useMemo(() => paginatedTours.map(([tourId, tour]) => departureKeyForTour(tourId, tour)).filter(Boolean), [paginatedTours]);
  const visibleDepartureKeySignature = JSON.stringify(visibleDepartureKeys);
  const visibleTours = useMemo(() => Object.fromEntries(paginatedTours), [paginatedTours]);
  const packCoverageByTour = useMemo(() => buildTourPackCoverage({
    tours: visibleTours,
    drivers,
    statuses: packStatusSnapshot.statuses
  }), [visibleTours, drivers, packStatusSnapshot.statuses]);
  const packOperationsByTour = useMemo(() => buildDriverTourPackOperationsByTour({
    tours: visibleTours,
    progress: packOperationsSnapshot.progress,
    issues: packOperationsSnapshot.issues
  }), [visibleTours, packOperationsSnapshot.progress, packOperationsSnapshot.issues]);
  useEffect(() => subscribeToDriverTourPackOperations(db, JSON.parse(visibleDepartureKeySignature), setPackOperationsSnapshot, () => {
    setSyncStatus('error');
  }), [visibleDepartureKeySignature]);
  const handleIssueStatus = async (issue, status) => {
    if (!issue || updatingIssueId) return;
    setUpdatingIssueId(issue.issueId);
    try {
      await updateDriverTourPackIssueStatus(db, {
        departureKey: issue.departureKey,
        driverId: issue.driverId,
        issueId: issue.issueId,
        status
      });
      notifications.show({
        title: 'Driver issue updated',
        message: `Issue marked ${status.toLowerCase()}.`,
        color: 'green'
      });
    } catch (error) {
      notifications.show({
        title: 'Issue update failed',
        message: error?.message || 'Could not update this driver issue.',
        color: 'red'
      });
    } finally {
      setUpdatingIssueId(null);
    }
  };

  // Modal handlers
  const handleEdit = tourId => {
    setSelectedTourId(tourId);
    openEditModal();
  };
  const handleDelete = tourId => {
    setSelectedTourId(tourId);
    openDeleteModal();
  };
  const handleViewDetails = tourId => {
    setSelectedTourId(tourId);
    openDetailsModal();
  };
  const handleAddPassenger = (tourId = null) => {
    setSelectedTourId(tourId);
    openAddPassengerModal();
  };
  const handleDuplicate = async tourId => {
    try {
      const result = await duplicateTour(tourId, 'admin');
      notifications.show({
        title: 'Tour Duplicated',
        message: `Created copy: ${result.id}`,
        color: 'green'
      });
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red'
      });
    }
  };
  const handleTourCreated = _tourId => {
    setCurrentPage(1);
  };
  const handlePassengerCreated = result => {
    if (result?.tourId) {
      setSelectedTourId(result.tourId);
    }
  };
  const selectedTour = selectedTourId ? tours[selectedTourId] : null;
  if (loading) {
    return <Center style={{
      minHeight: 400
    }}>
        <Stack align="center" gap="md">
          <Loader size="lg" color="brand" />
          <Text c="dimmed">Loading tours...</Text>
        </Stack>
      </Center>;
  }
  return <ToursManagerView {...{
    activeTours,
    addPassengerModalOpened,
    assignedTours,
    closeAddPassengerModal,
    closeCreateModal,
    closeDeleteModal,
    closeDetailsModal,
    closeEditModal,
    closeImportExportModal,
    createModalOpened,
    currentPage,
    deleteModalOpened,
    detailsModalOpened,
    driverDirectoryAtLimit,
    drivers,
    editModalOpened,
    filterDateScope,
    filterStatus,
    filteredTours,
    handleAddPassenger,
    handleDateScopeChange,
    handleDelete,
    handleDuplicate,
    handleEdit,
    handleFilterStatusChange,
    handleIssueStatus,
    handlePassengerCreated,
    handleSearchTermChange,
    handleTourCreated,
    handleViewDetails,
    helpExpanded,
    importExportModalOpened,
    openCreateModal,
    openImportExportModal,
    packCoverageByTour,
    packOperationsByTour,
    packOperationsSnapshot,
    packStatusSnapshot,
    paginatedTours,
    searchTerm,
    selectedTour,
    selectedTourId,
    setCurrentPage,
    setHelpExpanded,
    setSelectedTourId,
    setViewMode,
    syncStatus,
    totalPages,
    totalParticipants,
    totalTours,
    tourWindow,
    tours,
    unassignedTours,
    updatingIssueId,
    viewMode
  }} />;
}
