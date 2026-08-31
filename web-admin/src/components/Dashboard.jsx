import { useEffect, useMemo, useState } from 'react';
import DashboardView from '../features/dashboard/presentation/DashboardView';
import { useNavigate } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { Center, Loader, Stack, Text } from '@mantine/core';
import { IconActivity, IconClock, IconRefresh } from '@tabler/icons-react';
import { getAdminDatabase, getCurrentAdminUser } from '../shared/runtime/adminRuntime';
import { HEALTH_STATE, buildHealthSnapshot } from '../services/healthService';
import { SAFETY_STATUS, buildOperationsDashboardModel, filterSafetyAlerts, revalidateDashboardBranches, subscribeToDashboardBranches, updateSafetyAlertStatus } from '../services/dashboardService';
import { buildOperationsDashboardProjectionModel } from '../services/dashboardProjectionModel';
import {
  compareDashboardProjectionSections,
  fetchDashboardProjection,
  subscribeToDashboardProjection,
  subscribeToDashboardRollout,
} from '../services/dashboardProjectionService';
import { acknowledgeOpsAlert, buildOpsAlertStats, fetchOpsAlerts, filterOpsAlerts, resolveOpsAlert, subscribeToOpsAlerts } from '../services/opsAlertService';
import { getRuntimeDebugContext, logFirebaseDebug, logFirebaseError, startFirebaseDebugTimer, summarizeDataValue, summarizeDatabaseInstance } from '../services/firebaseDebug';
import { formatLongDateForDisplay, nowAsISOString } from '../utils/dateUtils';
const OPS_ALERT_QUERY = {
  orderBy: 'lastSeenAtMs',
  limit: 80
};
const db = getAdminDatabase();
const BRANCH_LABELS = {
  drivers: {
    label: 'Drivers',
    description: 'Driver roster and assignment helpers'
  },
  tours: {
    label: 'Tours',
    description: 'Tour records, capacity, safety branches'
  },
  tourManifests: {
    label: 'Manifests',
    description: 'Assigned drivers and passenger manifests'
  },
  globalSafetyAlerts: {
    label: 'Safety',
    description: 'Global SOS and critical safety alerts'
  },
  broadcasts: {
    label: 'Broadcasts',
    description: 'Admin passenger announcements'
  },
  opsAlerts: {
    label: 'App errors',
    description: 'Curated mobile app/device failures'
  }
};
const createBranchState = value => ({
  drivers: value,
  tours: value,
  tourManifests: value,
  globalSafetyAlerts: value,
  broadcasts: value,
  opsAlerts: value
});
function formatCount(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-GB') : '0';
}
export default function Dashboard() {
  const navigate = useNavigate();
  const [branchData, setBranchData] = useState({
    drivers: {},
    tours: {},
    tourManifests: {},
    globalSafetyAlerts: {},
    broadcasts: {}
  });
  const [projectionData, setProjectionData] = useState({
    tours: {},
    safetyAttention: {},
    recentBroadcasts: {},
    summary: {}
  });
  const [rolloutPhase, setRolloutPhase] = useState('legacy');
  const [rolloutLoaded, setRolloutLoaded] = useState(false);
  const [branchLoading, setBranchLoading] = useState(createBranchState(true));
  const [branchErrors, setBranchErrors] = useState({});
  const [branchSyncedAt, setBranchSyncedAt] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [opsAlerts, setOpsAlerts] = useState([]);
  const [opsSeverityFilter, setOpsSeverityFilter] = useState('all');
  const [opsStatusFilter, setOpsStatusFilter] = useState('active');
  const [safetyStatusFilter, setSafetyStatusFilter] = useState('attention');
  const [mutatingAlertId, setMutatingAlertId] = useState(null);
  const [mutatingSafetyId, setMutatingSafetyId] = useState(null);
  const [healthSignals, setHealthSignals] = useState({
    isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    listenerConnected: true,
    listenerErrorCount: 0,
    pendingFailedOperations: 0,
    backlogPendingCount: 0,
    lastSuccessfulSyncAt: null
  });
  const healthSnapshot = useMemo(() => buildHealthSnapshot(healthSignals), [healthSignals]);
  const opsAlertStats = useMemo(() => buildOpsAlertStats(opsAlerts), [opsAlerts]);
  const legacyDashboardModel = useMemo(() => buildOperationsDashboardModel({
    ...branchData,
    opsAlerts
  }), [branchData, opsAlerts]);
  const projectedDashboardModel = useMemo(() => buildOperationsDashboardProjectionModel({
    ...projectionData,
    opsAlerts
  }), [opsAlerts, projectionData]);
  const dashboardModel = rolloutPhase === 'projection' ? projectedDashboardModel : legacyDashboardModel;
  const visibleOpsAlerts = useMemo(() => filterOpsAlerts(opsAlerts, {
    severity: opsSeverityFilter,
    status: opsStatusFilter
  }).slice(0, 8), [opsAlerts, opsSeverityFilter, opsStatusFilter]);
  const visibleSafetyAlerts = useMemo(() => filterSafetyAlerts(dashboardModel.safetyAlerts, safetyStatusFilter).slice(0, 8), [dashboardModel.safetyAlerts, safetyStatusFilter]);
  useEffect(() => {
    logFirebaseDebug('dashboard:health-signals:changed', {
      healthSignals,
      healthSnapshot,
      branchLoading,
      branchErrorKeys: Object.keys(branchErrors),
      branchSyncedAt
    }, healthSnapshot.state === HEALTH_STATE.ONLINE_HEALTHY ? 'info' : 'warn');
  }, [branchErrors, branchLoading, branchSyncedAt, healthSignals, healthSnapshot]);
  useEffect(() => subscribeToDashboardRollout(db, phase => {
    setRolloutPhase(phase);
    setRolloutLoaded(true);
  }, error => {
    logFirebaseError('dashboard:rollout:error', error, { fallbackPhase: 'legacy' });
    setRolloutPhase('legacy');
    setRolloutLoaded(true);
  }), []);
  useEffect(() => {
    if (!rolloutLoaded) return undefined;
    logFirebaseDebug('dashboard:component:mount', {
      database: summarizeDatabaseInstance(db),
      runtime: getRuntimeDebugContext(),
      initialBrowserOnline: typeof navigator === 'undefined' ? null : navigator.onLine,
      opsAlertQuery: OPS_ALERT_QUERY,
      watchedBranches: Object.keys(BRANCH_LABELS),
      rolloutPhase
    }, 'info');
    const recordSuccess = (key, syncedAt, value) => {
      logFirebaseDebug('dashboard:component:record-success', {
        key,
        syncedAt,
        valueSummary: summarizeDataValue(value || {})
      }, 'info');
      setBranchLoading(current => ({
        ...current,
        [key]: false
      }));
      setBranchSyncedAt(current => ({
        ...current,
        [key]: syncedAt
      }));
      setBranchErrors(current => {
        const next = {
          ...current
        };
        delete next[key];
        return next;
      });
      setHealthSignals(current => ({
        ...current,
        lastSuccessfulSyncAt: syncedAt,
        listenerConnected: true
      }));
    };
    const recordError = (key, error) => {
      logFirebaseError('dashboard:component:record-error', error || new Error('Listener failed'), {
        key,
        database: summarizeDatabaseInstance(db),
        runtime: getRuntimeDebugContext()
      });
      setBranchLoading(current => ({
        ...current,
        [key]: false
      }));
      setBranchErrors(current => ({
        ...current,
        [key]: error || new Error('Listener failed')
      }));
      setHealthSignals(current => ({
        ...current,
        listenerConnected: false,
        listenerErrorCount: current.listenerErrorCount + 1,
        pendingFailedOperations: current.pendingFailedOperations + 1
      }));
    };
    const sourceUnsubscribers = [];
    if (rolloutPhase === 'legacy' || rolloutPhase === 'shadow') {
      sourceUnsubscribers.push(...subscribeToDashboardBranches(db, {
        onData: (key, value, syncedAt) => {
          setBranchData(current => ({
            ...current,
            [key]: value
          }));
          recordSuccess(key, syncedAt, value);
        },
        onError: recordError
      }));
    }
    if (rolloutPhase === 'projection' || rolloutPhase === 'shadow') {
      sourceUnsubscribers.push(...subscribeToDashboardProjection(db, {}, {
        onData: (key, value, syncedAt) => {
          setProjectionData(current => ({ ...current, [key]: value }));
          if (key === 'summary') {
            recordSuccess('drivers', syncedAt, value);
            recordSuccess('tourManifests', syncedAt, value);
          } else {
            const branchKey = key === 'safetyAttention' ? 'globalSafetyAlerts'
              : key === 'recentBroadcasts' ? 'broadcasts' : key;
            recordSuccess(branchKey, syncedAt, value);
          }
        },
        onError: (key, error) => {
          const branchKey = key === 'safetyAttention' ? 'globalSafetyAlerts'
            : key === 'recentBroadcasts' ? 'broadcasts'
              : key === 'summary' ? 'drivers' : key;
          recordError(branchKey, error);
        }
      }));
    }
    const unsubscribeOpsAlerts = subscribeToOpsAlerts(db, OPS_ALERT_QUERY, alerts => {
      setOpsAlerts(alerts);
      recordSuccess('opsAlerts', nowAsISOString(), Object.fromEntries(alerts.map(alert => [alert.id, {
        severity: alert.severity,
        status: alert.status,
        component: alert.component,
        lastSeenAtMs: alert.lastSeenAtMs
      }])));
    }, error => recordError('opsAlerts', error));
    const handleOnline = () => {
      logFirebaseDebug('dashboard:browser-network:online', {
        runtime: getRuntimeDebugContext()
      }, 'info');
      setHealthSignals(current => ({
        ...current,
        isOnline: true
      }));
    };
    const handleOffline = () => {
      logFirebaseDebug('dashboard:browser-network:offline', {
        runtime: getRuntimeDebugContext()
      }, 'warn');
      setHealthSignals(current => ({
        ...current,
        isOnline: false,
        listenerConnected: false
      }));
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      logFirebaseDebug('dashboard:component:unmount', {
        database: summarizeDatabaseInstance(db)
      }, 'info');
      sourceUnsubscribers.forEach(unsubscribe => unsubscribe());
      unsubscribeOpsAlerts();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [rolloutLoaded, rolloutPhase]);
  useEffect(() => {
    if (rolloutPhase !== 'shadow') return;
    const comparison = compareDashboardProjectionSections({
      legacyModel: legacyDashboardModel,
      projectionModel: projectedDashboardModel,
      projectionTours: projectionData.tours,
      legacyBroadcasts: branchData.broadcasts,
      projectionBroadcasts: projectionData.recentBroadcasts
    });
    logFirebaseDebug('dashboard:projection:shadow-compare', comparison, comparison.matches ? 'info' : 'warn');
  }, [branchData.broadcasts, legacyDashboardModel, projectedDashboardModel, projectionData.recentBroadcasts, projectionData.tours, rolloutPhase]);
  const handleRefresh = async () => {
    setRefreshing(true);
    const refreshTimer = startFirebaseDebugTimer('dashboard:manual-refresh:ui', {
      database: summarizeDatabaseInstance(db),
      runtime: getRuntimeDebugContext(),
      healthSignalsBeforeRefresh: healthSignals,
      opsAlertQuery: OPS_ALERT_QUERY
    });
    try {
      const projectionMode = rolloutPhase === 'projection';
      const shadowMode = rolloutPhase === 'shadow';
      const [branches, refreshedOpsAlerts, shadowProjection] = await Promise.all([
        projectionMode ? fetchDashboardProjection(db) : revalidateDashboardBranches(db),
        fetchOpsAlerts(db, OPS_ALERT_QUERY),
        shadowMode ? fetchDashboardProjection(db) : Promise.resolve(null)
      ]);
      if (projectionMode) {
        setProjectionData({
          tours: branches.tours,
          safetyAttention: branches.safetyAttention,
          recentBroadcasts: branches.recentBroadcasts,
          summary: branches.summary
        });
      } else {
        setBranchData({
          drivers: branches.drivers,
          tours: branches.tours,
          tourManifests: branches.tourManifests,
          globalSafetyAlerts: branches.globalSafetyAlerts,
          broadcasts: branches.broadcasts
        });
      }
      if (shadowProjection) {
        setProjectionData({
          tours: shadowProjection.tours,
          safetyAttention: shadowProjection.safetyAttention,
          recentBroadcasts: shadowProjection.recentBroadcasts,
          summary: shadowProjection.summary
        });
      }
      setOpsAlerts(refreshedOpsAlerts);
      setBranchLoading(createBranchState(false));
      setBranchErrors({});
      setBranchSyncedAt({
        drivers: branches.revalidatedAt,
        tours: branches.revalidatedAt,
        tourManifests: branches.revalidatedAt,
        globalSafetyAlerts: branches.revalidatedAt,
        broadcasts: branches.revalidatedAt,
        opsAlerts: branches.revalidatedAt
      });
      setHealthSignals({
        isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
        listenerConnected: true,
        listenerErrorCount: 0,
        pendingFailedOperations: 0,
        backlogPendingCount: 0,
        lastSuccessfulSyncAt: branches.revalidatedAt
      });
      refreshTimer.success({
        rolloutPhase,
        dashboardSummary: projectionMode
          ? summarizeDataValue(branches.summary)
          : summarizeDataValue(branches.tours),
        opsAlertsCount: refreshedOpsAlerts.length,
        revalidatedAt: branches.revalidatedAt
      });
      notifications.show({
        title: 'Dashboard refreshed',
        message: 'Displayed operations data was revalidated from Firebase.',
        color: 'green'
      });
    } catch (error) {
      refreshTimer.failure(error, {
        healthSignalsBeforeRefresh: healthSignals
      });
      setHealthSignals(current => ({
        ...current,
        pendingFailedOperations: current.pendingFailedOperations + 1,
        backlogPendingCount: current.backlogPendingCount + 1
      }));
      notifications.show({
        title: 'Refresh failed',
        message: 'Unable to revalidate one or more dashboard data sources.',
        color: 'red'
      });
    } finally {
      setRefreshing(false);
    }
  };
  const handleOpsAlertAction = async (alertId, action) => {
    setMutatingAlertId(alertId);
    const actionTimer = startFirebaseDebugTimer('dashboard:ops-alert-action', {
      alertId,
      action,
      database: summarizeDatabaseInstance(db)
    });
    try {
      if (action === 'resolve') {
        await resolveOpsAlert(db, alertId, getCurrentAdminUser()?.uid);
      } else {
        await acknowledgeOpsAlert(db, alertId, getCurrentAdminUser()?.uid);
      }
      actionTimer.success();
      notifications.show({
        title: action === 'resolve' ? 'Alert resolved' : 'Alert acknowledged',
        message: 'The operations alert status was updated.',
        color: action === 'resolve' ? 'green' : 'yellow'
      });
    } catch (error) {
      actionTimer.failure(error);
      notifications.show({
        title: 'Alert update failed',
        message: 'Unable to update the operations alert status.',
        color: 'red'
      });
    } finally {
      setMutatingAlertId(null);
    }
  };
  const handleSafetyAction = async (alert, status) => {
    setMutatingSafetyId(alert.id);
    const actionTimer = startFirebaseDebugTimer('dashboard:safety-alert-action', {
      alertId: alert.id,
      status,
      paths: alert.paths,
      database: summarizeDatabaseInstance(db)
    });
    try {
      await updateSafetyAlertStatus(db, alert, status, getCurrentAdminUser()?.uid);
      actionTimer.success();
      notifications.show({
        title: status === SAFETY_STATUS.RESOLVED ? 'Safety alert resolved' : 'Safety alert acknowledged',
        message: 'The safety alert status was updated.',
        color: status === SAFETY_STATUS.RESOLVED ? 'green' : 'yellow'
      });
    } catch (error) {
      actionTimer.failure(error);
      notifications.show({
        title: 'Safety update failed',
        message: 'Unable to update the safety alert status.',
        color: 'red'
      });
    } finally {
      setMutatingSafetyId(null);
    }
  };
  const primaryLoading = branchLoading.drivers || branchLoading.tours;
  const opsAlertsError = branchErrors.opsAlerts;
  const metrics = dashboardModel.metrics;
  const broadcastActivity = dashboardModel.broadcastActivity;
  const componentSummary = dashboardModel.componentAlertSummary.slice(0, 6);
  const today = formatLongDateForDisplay(nowAsISOString(), '-');
  const branchKeys = Object.keys(BRANCH_LABELS);
  const branchErrorCount = Object.keys(branchErrors).length;
  const branchLoadingCount = Object.values(branchLoading).filter(Boolean).length;
  const syncSummaryCards = [{
    label: 'Browser network',
    description: healthSignals.isOnline ? 'Browser reports an online network state' : 'Browser reports offline network state',
    color: healthSignals.isOnline ? 'green' : 'red',
    value: healthSignals.isOnline ? 'Online' : 'Offline',
    icon: IconActivity
  }, {
    label: 'Realtime listeners',
    description: `${formatCount(branchKeys.length - branchLoadingCount - branchErrorCount)} loaded / ${formatCount(branchErrorCount)} degraded`,
    color: branchErrorCount > 0 ? 'red' : branchLoadingCount > 0 ? 'yellow' : 'green',
    value: branchErrorCount > 0 ? 'Degraded' : branchLoadingCount > 0 ? 'Loading' : 'Loaded',
    icon: IconClock
  }, {
    label: 'Manual refresh',
    description: `${formatCount(healthSignals.pendingFailedOperations)} failed refresh/listener operations tracked this session`,
    color: healthSignals.pendingFailedOperations > 0 ? 'orange' : 'green',
    value: healthSignals.pendingFailedOperations > 0 ? 'Retryable' : 'Clear',
    icon: IconRefresh
  }];
  if (primaryLoading) {
    return <Center style={{
      minHeight: 420
    }}>
        <Stack align="center" gap="md">
          <Loader size="lg" color="brand" />
          <Text c="dimmed">Loading live operations data...</Text>
        </Stack>
      </Center>;
  }
  return <DashboardView {...{
    branchErrors,
    branchKeys,
    branchLoading,
    branchSyncedAt,
    broadcastActivity,
    componentSummary,
    dashboardModel,
    handleOpsAlertAction,
    handleRefresh,
    handleSafetyAction,
    healthSignals,
    healthSnapshot,
    metrics,
    mutatingAlertId,
    mutatingSafetyId,
    navigate,
    opsAlertStats,
    opsAlerts,
    opsAlertsError,
    opsSeverityFilter,
    opsStatusFilter,
    refreshing,
    safetyStatusFilter,
    setOpsSeverityFilter,
    setOpsStatusFilter,
    setSafetyStatusFilter,
    syncSummaryCards,
    today,
    visibleOpsAlerts,
    visibleSafetyAlerts
  }} />;
}
