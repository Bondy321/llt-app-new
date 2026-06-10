import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Divider,
  Flex,
  Group,
  Loader,
  Paper,
  Progress,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconActivity,
  IconAlertTriangle,
  IconBolt,
  IconBug,
  IconCalendar,
  IconCheck,
  IconChecklist,
  IconCircleCheck,
  IconClock,
  IconDeviceMobile,
  IconExternalLink,
  IconInfoCircle,
  IconMap,
  IconMessageCircle,
  IconRefresh,
  IconRoute,
  IconShieldCheck,
  IconSpeakerphone,
  IconUsers,
} from '@tabler/icons-react';
import { db } from '../firebase';
import { HEALTH_STATE, buildHealthSnapshot } from '../services/healthService';
import {
  SAFETY_STATUS,
  SAFETY_STATUS_OPTIONS,
  buildOperationsDashboardModel,
  filterSafetyAlerts,
  revalidateDashboardBranches,
  subscribeToDashboardBranches,
  updateSafetyAlertStatus,
} from '../services/dashboardService';
import {
  OPS_ALERT_SEVERITY_OPTIONS,
  OPS_ALERT_STATUS,
  OPS_ALERT_STATUS_OPTIONS,
  acknowledgeOpsAlert,
  buildOpsAlertStats,
  fetchOpsAlerts,
  filterOpsAlerts,
  formatAffectedDevice,
  formatAffectedSession,
  resolveOpsAlert,
  subscribeToOpsAlerts,
} from '../services/opsAlertService';
import {
  getRuntimeDebugContext,
  logFirebaseDebug,
  logFirebaseError,
  startFirebaseDebugTimer,
  summarizeDataValue,
  summarizeDatabaseInstance,
} from '../services/firebaseDebug';
import {
  formatDateForDisplay,
  formatDateTimeForDisplay,
  formatLongDateForDisplay,
  formatTimeForDisplay,
  nowAsISOString,
} from '../utils/dateUtils';

const OPS_ALERT_QUERY = { orderBy: 'lastSeenAtMs', limit: 80 };

const OPS_SEVERITY_COLOR = {
  critical: 'red',
  error: 'orange',
  warning: 'yellow',
  info: 'blue',
};

const OPS_STATUS_COLOR = {
  [OPS_ALERT_STATUS.OPEN]: 'red',
  [OPS_ALERT_STATUS.ACKNOWLEDGED]: 'yellow',
  [OPS_ALERT_STATUS.RESOLVED]: 'green',
};

const SAFETY_SEVERITY_COLOR = {
  critical: 'red',
  high: 'orange',
  medium: 'yellow',
  low: 'green',
};

const SAFETY_STATUS_COLOR = {
  [SAFETY_STATUS.PENDING]: 'red',
  [SAFETY_STATUS.ACKNOWLEDGED]: 'yellow',
  [SAFETY_STATUS.IN_PROGRESS]: 'blue',
  [SAFETY_STATUS.ESCALATED]: 'orange',
  [SAFETY_STATUS.RESOLVED]: 'green',
};

const BRANCH_LABELS = {
  drivers: {
    label: 'Drivers',
    description: 'Driver roster and assignment helpers',
  },
  tours: {
    label: 'Tours',
    description: 'Tour records, capacity, safety branches',
  },
  tourManifests: {
    label: 'Manifests',
    description: 'Assigned drivers and passenger manifests',
  },
  globalSafetyAlerts: {
    label: 'Safety',
    description: 'Global SOS and critical safety alerts',
  },
  broadcasts: {
    label: 'Broadcasts',
    description: 'Admin passenger announcements',
  },
  opsAlerts: {
    label: 'App errors',
    description: 'Curated mobile app/device failures',
  },
};

const createBranchState = (value) => ({
  drivers: value,
  tours: value,
  tourManifests: value,
  globalSafetyAlerts: value,
  broadcasts: value,
  opsAlerts: value,
});

function formatPercent(value, fallback = 'No dated tours') {
  return value === null || value === undefined ? fallback : `${value}%`;
}

function formatCount(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-GB') : '0';
}

function openToursUrl(navigate, params = {}) {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.q) search.set('q', params.q);
  const suffix = search.toString();
  navigate(`/tours${suffix ? `?${suffix}` : ''}`);
}

function MetricCard({ title, value, icon: _Icon, color, subtitle, detail }) {
  return (
    <Card shadow="sm" padding="md" radius="md" withBorder>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            {title}
          </Text>
          <Title order={2}>{value}</Title>
          <Text size="xs" c="dimmed">
            {subtitle}
          </Text>
          {detail ? (
            <Text size="xs" c="dimmed">
              {detail}
            </Text>
          ) : null}
        </Stack>
        <ThemeIcon color={color} variant="light" radius="md" size={44}>
          <_Icon size={21} stroke={1.7} />
        </ThemeIcon>
      </Group>
    </Card>
  );
}

function OpsAlertBadge({ value, kind = 'severity' }) {
  const color = kind === 'status'
    ? OPS_STATUS_COLOR[value] || 'gray'
    : OPS_SEVERITY_COLOR[value] || 'gray';

  return (
    <Badge size="sm" color={color} variant={kind === 'status' ? 'light' : 'filled'}>
      {value || 'unknown'}
    </Badge>
  );
}

function SafetyBadge({ value, kind = 'severity' }) {
  const color = kind === 'status'
    ? SAFETY_STATUS_COLOR[value] || 'gray'
    : SAFETY_SEVERITY_COLOR[value] || 'gray';

  return (
    <Badge size="sm" color={color} variant={kind === 'status' ? 'light' : 'filled'}>
      {String(value || 'unknown').replace(/_/g, ' ')}
    </Badge>
  );
}

function BranchHealthRow({ branchKey, loading, error, syncedAt }) {
  const meta = BRANCH_LABELS[branchKey];
  const color = error ? 'red' : loading ? 'yellow' : 'green';
  const label = error ? 'Degraded' : loading ? 'Loading' : 'Loaded';

  return (
    <Paper p="sm" radius="md" withBorder>
      <Group wrap="nowrap" align="center">
        <ThemeIcon color={color} variant="light" size="md" radius="md">
          {error ? <IconAlertTriangle size={15} /> : <IconActivity size={15} />}
        </ThemeIcon>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={600}>{meta.label}</Text>
          <Text size="xs" c="dimmed" truncate="end">{meta.description}</Text>
          <Text size="xs" c="dimmed">
            Last update: {formatTimeForDisplay(syncedAt, 'awaiting data')}
          </Text>
        </Box>
        <Badge size="sm" color={color} variant="light">{label}</Badge>
      </Group>
    </Paper>
  );
}

function PanelHeader({ icon: _Icon, title, description, right }) {
  return (
    <Group justify="space-between" align="flex-start" mb="md" gap="md">
      <Group gap="sm" align="flex-start">
        <ThemeIcon color="brand" variant="light" size="lg" radius="md">
          <_Icon size={18} />
        </ThemeIcon>
        <Box>
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed">{description}</Text>
        </Box>
      </Group>
      {right}
    </Group>
  );
}

function EmptyState({ icon: _Icon = IconCircleCheck, title, description, color = 'green' }) {
  return (
    <Center py="xl">
      <Stack align="center" gap="xs">
        <ThemeIcon color={color} variant="light" size="lg" radius="xl">
          <_Icon size={18} />
        </ThemeIcon>
        <Text size="sm" fw={600}>{title}</Text>
        {description ? (
          <Text size="xs" c="dimmed" ta="center" maw={360}>
            {description}
          </Text>
        ) : null}
      </Stack>
    </Center>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [branchData, setBranchData] = useState({
    drivers: {},
    tours: {},
    tourManifests: {},
    globalSafetyAlerts: {},
    broadcasts: {},
  });
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
    lastSuccessfulSyncAt: null,
  });

  const healthSnapshot = useMemo(() => buildHealthSnapshot(healthSignals), [healthSignals]);
  const opsAlertStats = useMemo(() => buildOpsAlertStats(opsAlerts), [opsAlerts]);
  const dashboardModel = useMemo(() => buildOperationsDashboardModel({
    ...branchData,
    opsAlerts,
  }), [branchData, opsAlerts]);
  const visibleOpsAlerts = useMemo(() => filterOpsAlerts(opsAlerts, {
    severity: opsSeverityFilter,
    status: opsStatusFilter,
  }).slice(0, 8), [opsAlerts, opsSeverityFilter, opsStatusFilter]);
  const visibleSafetyAlerts = useMemo(() => filterSafetyAlerts(
    dashboardModel.safetyAlerts,
    safetyStatusFilter,
  ).slice(0, 8), [dashboardModel.safetyAlerts, safetyStatusFilter]);

  useEffect(() => {
    logFirebaseDebug('dashboard:health-signals:changed', {
      healthSignals,
      healthSnapshot,
      branchLoading,
      branchErrorKeys: Object.keys(branchErrors),
      branchSyncedAt,
    }, healthSnapshot.state === HEALTH_STATE.ONLINE_HEALTHY ? 'info' : 'warn');
  }, [branchErrors, branchLoading, branchSyncedAt, healthSignals, healthSnapshot]);

  useEffect(() => {
    logFirebaseDebug('dashboard:component:mount', {
      database: summarizeDatabaseInstance(db),
      runtime: getRuntimeDebugContext(),
      initialBrowserOnline: typeof navigator === 'undefined' ? null : navigator.onLine,
      opsAlertQuery: OPS_ALERT_QUERY,
      watchedBranches: Object.keys(BRANCH_LABELS),
    }, 'info');

    const recordSuccess = (key, syncedAt, value) => {
      logFirebaseDebug('dashboard:component:record-success', {
        key,
        syncedAt,
        valueSummary: summarizeDataValue(value || {}),
      }, 'info');
      setBranchLoading((current) => ({ ...current, [key]: false }));
      setBranchSyncedAt((current) => ({ ...current, [key]: syncedAt }));
      setBranchErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setHealthSignals((current) => ({
        ...current,
        lastSuccessfulSyncAt: syncedAt,
        listenerConnected: true,
      }));
    };

    const recordError = (key, error) => {
      logFirebaseError('dashboard:component:record-error', error || new Error('Listener failed'), {
        key,
        database: summarizeDatabaseInstance(db),
        runtime: getRuntimeDebugContext(),
      });
      setBranchLoading((current) => ({ ...current, [key]: false }));
      setBranchErrors((current) => ({ ...current, [key]: error || new Error('Listener failed') }));
      setHealthSignals((current) => ({
        ...current,
        listenerConnected: false,
        listenerErrorCount: current.listenerErrorCount + 1,
        pendingFailedOperations: current.pendingFailedOperations + 1,
      }));
    };

    const unsubscribeBranches = subscribeToDashboardBranches(db, {
      onData: (key, value, syncedAt) => {
        setBranchData((current) => ({ ...current, [key]: value }));
        recordSuccess(key, syncedAt, value);
      },
      onError: recordError,
    });

    const unsubscribeOpsAlerts = subscribeToOpsAlerts(
      db,
      OPS_ALERT_QUERY,
      (alerts) => {
        setOpsAlerts(alerts);
        recordSuccess('opsAlerts', nowAsISOString(), Object.fromEntries(alerts.map((alert) => [alert.id, {
          severity: alert.severity,
          status: alert.status,
          component: alert.component,
          lastSeenAtMs: alert.lastSeenAtMs,
        }])));
      },
      (error) => recordError('opsAlerts', error),
    );

    const handleOnline = () => {
      logFirebaseDebug('dashboard:browser-network:online', {
        runtime: getRuntimeDebugContext(),
      }, 'info');
      setHealthSignals((current) => ({ ...current, isOnline: true }));
    };

    const handleOffline = () => {
      logFirebaseDebug('dashboard:browser-network:offline', {
        runtime: getRuntimeDebugContext(),
      }, 'warn');
      setHealthSignals((current) => ({ ...current, isOnline: false, listenerConnected: false }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      logFirebaseDebug('dashboard:component:unmount', {
        database: summarizeDatabaseInstance(db),
      }, 'info');
      unsubscribeBranches.forEach((unsubscribe) => unsubscribe());
      unsubscribeOpsAlerts();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    const refreshTimer = startFirebaseDebugTimer('dashboard:manual-refresh:ui', {
      database: summarizeDatabaseInstance(db),
      runtime: getRuntimeDebugContext(),
      healthSignalsBeforeRefresh: healthSignals,
      opsAlertQuery: OPS_ALERT_QUERY,
    });

    try {
      const [branches, refreshedOpsAlerts] = await Promise.all([
        revalidateDashboardBranches(db),
        fetchOpsAlerts(db, OPS_ALERT_QUERY),
      ]);

      setBranchData({
        drivers: branches.drivers,
        tours: branches.tours,
        tourManifests: branches.tourManifests,
        globalSafetyAlerts: branches.globalSafetyAlerts,
        broadcasts: branches.broadcasts,
      });
      setOpsAlerts(refreshedOpsAlerts);
      setBranchLoading(createBranchState(false));
      setBranchErrors({});
      setBranchSyncedAt({
        drivers: branches.revalidatedAt,
        tours: branches.revalidatedAt,
        tourManifests: branches.revalidatedAt,
        globalSafetyAlerts: branches.revalidatedAt,
        broadcasts: branches.revalidatedAt,
        opsAlerts: branches.revalidatedAt,
      });
      setHealthSignals({
        isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
        listenerConnected: true,
        listenerErrorCount: 0,
        pendingFailedOperations: 0,
        backlogPendingCount: 0,
        lastSuccessfulSyncAt: branches.revalidatedAt,
      });
      refreshTimer.success({
        branchSummaries: {
          drivers: summarizeDataValue(branches.drivers),
          tours: summarizeDataValue(branches.tours),
          tourManifests: summarizeDataValue(branches.tourManifests),
          globalSafetyAlerts: summarizeDataValue(branches.globalSafetyAlerts),
          broadcasts: summarizeDataValue(branches.broadcasts),
        },
        opsAlertsCount: refreshedOpsAlerts.length,
        revalidatedAt: branches.revalidatedAt,
      });
      notifications.show({
        title: 'Dashboard refreshed',
        message: 'Displayed operations data was revalidated from Firebase.',
        color: 'green',
      });
    } catch (error) {
      refreshTimer.failure(error, {
        healthSignalsBeforeRefresh: healthSignals,
      });
      setHealthSignals((current) => ({
        ...current,
        pendingFailedOperations: current.pendingFailedOperations + 1,
        backlogPendingCount: current.backlogPendingCount + 1,
      }));
      notifications.show({
        title: 'Refresh failed',
        message: 'Unable to revalidate one or more dashboard data sources.',
        color: 'red',
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
      database: summarizeDatabaseInstance(db),
    });

    try {
      if (action === 'resolve') {
        await resolveOpsAlert(db, alertId);
      } else {
        await acknowledgeOpsAlert(db, alertId);
      }

      actionTimer.success();
      notifications.show({
        title: action === 'resolve' ? 'Alert resolved' : 'Alert acknowledged',
        message: 'The operations alert status was updated.',
        color: action === 'resolve' ? 'green' : 'yellow',
      });
    } catch (error) {
      actionTimer.failure(error);
      notifications.show({
        title: 'Alert update failed',
        message: 'Unable to update the operations alert status.',
        color: 'red',
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
      database: summarizeDatabaseInstance(db),
    });

    try {
      await updateSafetyAlertStatus(db, alert, status);
      actionTimer.success();
      notifications.show({
        title: status === SAFETY_STATUS.RESOLVED ? 'Safety alert resolved' : 'Safety alert acknowledged',
        message: 'The safety alert status was updated.',
        color: status === SAFETY_STATUS.RESOLVED ? 'green' : 'yellow',
      });
    } catch (error) {
      actionTimer.failure(error);
      notifications.show({
        title: 'Safety update failed',
        message: 'Unable to update the safety alert status.',
        color: 'red',
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
  const syncSummaryCards = [
    {
      label: 'Browser network',
      description: healthSignals.isOnline ? 'Browser reports an online network state' : 'Browser reports offline network state',
      color: healthSignals.isOnline ? 'green' : 'red',
      value: healthSignals.isOnline ? 'Online' : 'Offline',
      icon: IconActivity,
    },
    {
      label: 'Realtime listeners',
      description: `${formatCount(branchKeys.length - branchLoadingCount - branchErrorCount)} loaded / ${formatCount(branchErrorCount)} degraded`,
      color: branchErrorCount > 0 ? 'red' : branchLoadingCount > 0 ? 'yellow' : 'green',
      value: branchErrorCount > 0 ? 'Degraded' : branchLoadingCount > 0 ? 'Loading' : 'Loaded',
      icon: IconClock,
    },
    {
      label: 'Manual refresh',
      description: `${formatCount(healthSignals.pendingFailedOperations)} failed refresh/listener operations tracked this session`,
      color: healthSignals.pendingFailedOperations > 0 ? 'orange' : 'green',
      value: healthSignals.pendingFailedOperations > 0 ? 'Retryable' : 'Clear',
      icon: IconRefresh,
    },
  ];

  if (primaryLoading) {
    return (
      <Center style={{ minHeight: 420 }}>
        <Stack align="center" gap="md">
          <Loader size="lg" color="brand" />
          <Text c="dimmed">Loading live operations data...</Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" p="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Stack gap={6}>
            <Group gap="xs">
              <ThemeIcon color={healthSnapshot.color} variant="light" size="md" radius="md">
                <IconActivity size={16} />
              </ThemeIcon>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                Operations command hub
              </Text>
            </Group>
            <Title order={2}>Live Operations Dashboard</Title>
            <Text c="dimmed" maw={760}>
              Firebase-backed view of app failures, dispatch coverage, passenger load, safety alerts,
              broadcast activity, and realtime sync health.
            </Text>
            <Group gap="sm" mt="xs">
              <Badge color={healthSnapshot.color} variant="light">
                {healthSnapshot.label}
              </Badge>
              <Badge color="gray" variant="outline">
                {today}
              </Badge>
              <Badge color="gray" variant="outline">
                Last sync {formatTimeForDisplay(healthSignals.lastSuccessfulSyncAt, 'awaiting data')}
              </Badge>
            </Group>
          </Stack>

          <Flex align="center" gap="sm" wrap="wrap">
            <Tooltip label="Revalidate all dashboard data">
              <ActionIcon variant="light" size="lg" onClick={handleRefresh} loading={refreshing}>
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
            <Button
              variant="light"
              leftSection={<IconRoute size={16} />}
              onClick={() => openToursUrl(navigate, { status: 'unassigned' })}
            >
              Unassigned tours
            </Button>
            <Button
              leftSection={<IconSpeakerphone size={16} />}
              onClick={() => navigate('/broadcast')}
            >
              Broadcast
            </Button>
          </Flex>
        </Group>
      </Card>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
        <MetricCard
          title="Critical App Errors"
          value={formatCount(opsAlertStats.openCriticalCount)}
          icon={IconBug}
          color={opsAlertStats.openCriticalCount > 0 ? 'red' : 'green'}
          subtitle={`${formatCount(opsAlertStats.activeCount)} active app/device alerts`}
          detail={`${formatCount(opsAlertStats.openErrorCount)} open critical/error alerts`}
        />
        <MetricCard
          title="Driver Coverage"
          value={formatPercent(metrics.upcomingAssignmentCoveragePercent)}
          icon={IconUsers}
          color={metrics.unassignedUpcomingTours > 0 ? 'orange' : 'green'}
          subtitle={`${formatCount(metrics.assignedUpcomingTours)} of ${formatCount(metrics.upcomingTours)} upcoming dated tours assigned`}
          detail={`${formatCount(metrics.availableDrivers)} drivers without a current assignment`}
        />
        <MetricCard
          title="Unassigned Queue"
          value={formatCount(metrics.unassignedUpcomingTours)}
          icon={IconChecklist}
          color={metrics.unassignedUpcomingTours > 0 ? 'red' : 'green'}
          subtitle="Active tours due soon or recently overdue"
          detail={`${formatCount(metrics.missingDateOperationalTours)} active tours have no valid start date`}
        />
        <MetricCard
          title="Passenger Load"
          value={formatPercent(metrics.passengerLoadPercent, formatCount(metrics.totalPassengers))}
          icon={IconBolt}
          color={metrics.highLoadTours > 0 ? 'orange' : 'blue'}
          subtitle={`${formatCount(metrics.totalPassengers)} passengers / ${formatCount(metrics.totalKnownCapacity)} known seats`}
          detail={`${formatCount(metrics.unknownCapacityTours)} active tours missing capacity`}
        />
        <MetricCard
          title="Safety Attention"
          value={formatCount(metrics.safetyAttentionAlerts)}
          icon={IconShieldCheck}
          color={metrics.safetyAttentionAlerts > 0 ? 'red' : 'green'}
          subtitle="Pending, acknowledged, in-progress, or escalated alerts"
          detail={`${formatCount(dashboardModel.safetyAlerts.length)} safety alerts loaded`}
        />
        <MetricCard
          title="Broadcast Activity"
          value={formatCount(broadcastActivity.last24hCount)}
          icon={IconSpeakerphone}
          color="orange"
          subtitle={`${formatCount(broadcastActivity.totalCount)} broadcasts loaded across ${formatCount(broadcastActivity.tourCount)} tours`}
          detail={`Last sent ${formatDateTimeForDisplay(broadcastActivity.lastBroadcastAtMs, 'not available')}`}
        />
      </SimpleGrid>

      <Card shadow="sm" padding="md" radius="md" withBorder>
        <PanelHeader
          icon={IconDeviceMobile}
          title="Operations / Health / Errors"
          description="Curated mobile app and device failures from ops_alerts. Raw logs are not read here."
          right={(
            <Group gap="xs" justify="flex-end">
              <Badge color={opsAlertsError ? 'red' : branchLoading.opsAlerts ? 'yellow' : 'green'} variant="light">
                {opsAlertsError ? 'Degraded' : branchLoading.opsAlerts ? 'Loading' : 'Loaded'}
              </Badge>
              <Badge color={opsAlertStats.openCriticalCount > 0 ? 'red' : 'gray'} variant="filled">
                {formatCount(opsAlertStats.openCriticalCount)} critical
              </Badge>
            </Group>
          )}
        />

        <Group justify="space-between" mb="md" align="flex-end" wrap="wrap">
          <Group gap="sm">
            <Select
              label="Severity"
              data={OPS_ALERT_SEVERITY_OPTIONS}
              value={opsSeverityFilter}
              onChange={(value) => setOpsSeverityFilter(value || 'all')}
              w={180}
              allowDeselect={false}
            />
            <Select
              label="Status"
              data={OPS_ALERT_STATUS_OPTIONS}
              value={opsStatusFilter}
              onChange={(value) => setOpsStatusFilter(value || 'active')}
              w={190}
              allowDeselect={false}
            />
          </Group>
          <Text size="xs" c="dimmed">
            Showing {formatCount(visibleOpsAlerts.length)} of {formatCount(opsAlerts.length)} recent curated alerts
          </Text>
        </Group>

        {opsAlertsError ? (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="md">
            App/device error alerts are unavailable. Other dashboard listeners continue independently.
          </Alert>
        ) : null}

        {branchLoading.opsAlerts ? (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <Loader size="md" color="brand" />
              <Text size="sm" c="dimmed">Loading app/device alerts...</Text>
            </Stack>
          </Center>
        ) : visibleOpsAlerts.length > 0 ? (
          <ScrollArea type="auto">
            <Table highlightOnHover verticalSpacing="sm" miw={1060}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Severity</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Component</Table.Th>
                  <Table.Th>Message</Table.Th>
                  <Table.Th>Affected context</Table.Th>
                  <Table.Th>Last seen</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visibleOpsAlerts.map((alert) => (
                  <Table.Tr key={alert.id}>
                    <Table.Td>
                      <Stack gap={4}>
                        <OpsAlertBadge value={alert.severity} />
                        <Text size="xs" c="dimmed">{alert.level}</Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <OpsAlertBadge value={alert.status} kind="status" />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={700} truncate="end" maw={170}>{alert.component}</Text>
                      <Text size="xs" c="dimmed" truncate="end" maw={170}>{alert.source}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={600} lineClamp={2}>{alert.message}</Text>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {alert.crashBreadcrumbSummary?.latest || alert.summary || 'No summary'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" fw={600} truncate="end" maw={230}>
                        {formatAffectedDevice(alert)}
                      </Text>
                      <Text size="xs" c="dimmed" truncate="end" maw={230}>
                        {formatAffectedSession(alert)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={600}>{formatDateTimeForDisplay(alert.lastSeenAtMs, 'unknown')}</Text>
                      <Text size="xs" c="dimmed">Seen {formatCount(alert.count)}x</Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        {alert.tourId ? (
                          <Tooltip label="Open tour">
                            <ActionIcon
                              variant="light"
                              color="blue"
                              onClick={() => openToursUrl(navigate, { q: alert.tourId })}
                            >
                              <IconExternalLink size={16} />
                            </ActionIcon>
                          </Tooltip>
                        ) : null}
                        {alert.status === OPS_ALERT_STATUS.OPEN ? (
                          <Tooltip label="Acknowledge alert">
                            <ActionIcon
                              variant="light"
                              color="yellow"
                              loading={mutatingAlertId === alert.id}
                              onClick={() => handleOpsAlertAction(alert.id, 'acknowledge')}
                            >
                              <IconCheck size={16} />
                            </ActionIcon>
                          </Tooltip>
                        ) : null}
                        {alert.status !== OPS_ALERT_STATUS.RESOLVED ? (
                          <Tooltip label="Resolve alert">
                            <ActionIcon
                              variant="light"
                              color="green"
                              loading={mutatingAlertId === alert.id}
                              onClick={() => handleOpsAlertAction(alert.id, 'resolve')}
                            >
                              <IconCircleCheck size={16} />
                            </ActionIcon>
                          </Tooltip>
                        ) : (
                          <Badge color="green" variant="light">Closed</Badge>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        ) : (
          <EmptyState
            title="No matching app/device alerts"
            description="The curated operations alert stream is clear for the current filters."
          />
        )}

        <Divider my="md" />

        <Title order={5} mb="sm">Recent Warnings And Errors By Component</Title>
        {componentSummary.length > 0 ? (
          <ScrollArea type="auto">
            <Table verticalSpacing="sm" miw={760}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Component</Table.Th>
                  <Table.Th>Highest severity</Table.Th>
                  <Table.Th>Active</Table.Th>
                  <Table.Th>Latest message</Table.Th>
                  <Table.Th>Latest seen</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {componentSummary.map((item) => (
                  <Table.Tr key={item.component}>
                    <Table.Td><Text size="sm" fw={700}>{item.component}</Text></Table.Td>
                    <Table.Td><OpsAlertBadge value={item.maxSeverity} /></Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {formatCount(item.activeCount)} total - {formatCount(item.criticalCount)} critical / {formatCount(item.errorCount)} error
                      </Text>
                    </Table.Td>
                    <Table.Td><Text size="sm" lineClamp={2}>{item.latestMessage}</Text></Table.Td>
                    <Table.Td><Text size="sm">{formatDateTimeForDisplay(item.latestSeenAtMs, 'unknown')}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        ) : (
          <EmptyState
            icon={IconInfoCircle}
            color="blue"
            title="No active warning/error components"
            description="No unresolved warning, error, or critical component groups are present in the loaded alert window."
          />
        )}
      </Card>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Card shadow="sm" padding="md" radius="md" withBorder>
          <PanelHeader
            icon={IconRoute}
            title="Driver Assignment Coverage"
            description="Coverage is derived from tour driver fields, driver currentTourId, and manifest assignment links."
            right={(
              <Button
                size="xs"
                variant="light"
                leftSection={<IconExternalLink size={14} />}
                onClick={() => openToursUrl(navigate, { status: 'unassigned' })}
              >
                Open queue
              </Button>
            )}
          />

          <Stack gap="md">
            <Box>
              <Group justify="space-between" mb={6}>
                <Text size="sm" fw={600}>Upcoming dated tour coverage</Text>
                <Text size="sm" c="dimmed">{formatPercent(metrics.upcomingAssignmentCoveragePercent)}</Text>
              </Group>
              <Progress value={metrics.upcomingAssignmentCoveragePercent || 0} color={metrics.unassignedUpcomingTours > 0 ? 'orange' : 'green'} radius="xl" size="lg" />
            </Box>
            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
              <Paper p="sm" radius="md" withBorder>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Drivers</Text>
                <Text fw={800}>{formatCount(metrics.totalDrivers)}</Text>
              </Paper>
              <Paper p="sm" radius="md" withBorder>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Assigned</Text>
                <Text fw={800}>{formatCount(metrics.assignedDrivers)}</Text>
              </Paper>
              <Paper p="sm" radius="md" withBorder>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Upcoming</Text>
                <Text fw={800}>{formatCount(metrics.upcomingTours)}</Text>
              </Paper>
              <Paper p="sm" radius="md" withBorder>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Unassigned</Text>
                <Text fw={800} c={metrics.unassignedUpcomingTours > 0 ? 'red' : 'green'}>
                  {formatCount(metrics.unassignedUpcomingTours)}
                </Text>
              </Paper>
            </SimpleGrid>

            {dashboardModel.unassignedUpcomingTours.length > 0 ? (
              <Stack gap="xs">
                {dashboardModel.unassignedUpcomingTours.map((tour) => (
                  <Paper key={tour.id} p="sm" radius="md" withBorder>
                    <Group justify="space-between" align="center" wrap="nowrap">
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Text fw={700} size="sm" truncate="end">{tour.name}</Text>
                        <Text size="xs" c="dimmed">
                          Starts {formatDateForDisplay(tour.startDate)} - {formatCount(tour.passengerCount)} passengers
                        </Text>
                      </Box>
                      <Group gap="xs" wrap="nowrap">
                        <Badge size="sm" color={tour.dateMeta.urgency?.color || 'gray'} variant="filled">
                          {tour.dateMeta.urgency?.label || 'No date'}
                        </Badge>
                        <Tooltip label="Open tour">
                          <ActionIcon variant="light" onClick={() => openToursUrl(navigate, { status: 'unassigned', q: tour.id })}>
                            <IconExternalLink size={15} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            ) : (
              <EmptyState
                title="No unassigned tours in the attention window"
                description="Active tours due in the configured attention window currently have driver coverage."
              />
            )}
          </Stack>
        </Card>

        <Card shadow="sm" padding="md" radius="md" withBorder>
          <PanelHeader
            icon={IconMap}
            title="Passenger Load And Capacity"
            description="Passenger load is derived from tour counts first, then participants or manifests when needed."
            right={(
              <Button
                size="xs"
                variant="light"
                leftSection={<IconExternalLink size={14} />}
                onClick={() => openToursUrl(navigate)}
              >
                Open tours
              </Button>
            )}
          />

          <Stack gap="md">
            <Box>
              <Group justify="space-between" mb={6}>
                <Text size="sm" fw={600}>Known seat utilization</Text>
                <Text size="sm" c="dimmed">{formatPercent(metrics.passengerLoadPercent, 'No capacity data')}</Text>
              </Group>
              <Progress value={metrics.passengerLoadPercent || 0} color={metrics.highLoadTours > 0 ? 'orange' : 'blue'} radius="xl" size="lg" />
            </Box>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">Passengers on active tours</Text>
              <Text fw={700}>{formatCount(metrics.totalPassengers)}</Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">Known active capacity</Text>
              <Text fw={700}>{formatCount(metrics.totalKnownCapacity)}</Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">Tours missing capacity</Text>
              <Badge color={metrics.unknownCapacityTours > 0 ? 'yellow' : 'green'} variant="light">
                {formatCount(metrics.unknownCapacityTours)}
              </Badge>
            </Group>

            <Divider />

            <Text size="sm" fw={700}>High Load Tours</Text>
            {dashboardModel.highLoadTours.length > 0 ? (
              <Stack gap="xs">
                {dashboardModel.highLoadTours.map((tour) => (
                  <Paper key={tour.id} p="sm" radius="md" withBorder>
                    <Group justify="space-between" align="center" wrap="nowrap">
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Text fw={700} size="sm" truncate="end">{tour.name}</Text>
                        <Text size="xs" c="dimmed">
                          {formatCount(tour.passengerCount)} / {formatCount(tour.capacity)} passengers - source {tour.passengerCountSource}
                        </Text>
                      </Box>
                      <Group gap="xs" wrap="nowrap">
                        <Badge color={tour.loadPercent > 100 ? 'red' : 'orange'} variant="filled">
                          {formatPercent(tour.loadPercent)}
                        </Badge>
                        <Tooltip label="Open tour">
                          <ActionIcon variant="light" onClick={() => openToursUrl(navigate, { q: tour.id })}>
                            <IconExternalLink size={15} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            ) : (
              <EmptyState
                icon={IconCircleCheck}
                title="No high-load tours"
                description="No active tour with known capacity is currently above the load threshold."
              />
            )}
          </Stack>
        </Card>

        <Card shadow="sm" padding="md" radius="md" withBorder>
          <PanelHeader
            icon={IconShieldCheck}
            title="Safety Alerts Requiring Attention"
            description="Shows sanitized safety summaries only. User IDs, bookings, raw locations, and auth values stay hidden."
            right={(
              <Select
                data={SAFETY_STATUS_OPTIONS}
                value={safetyStatusFilter}
                onChange={(value) => setSafetyStatusFilter(value || 'attention')}
                w={190}
                allowDeselect={false}
              />
            )}
          />

          {branchErrors.globalSafetyAlerts ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="md">
              Global safety alerts are unavailable. Tour safety branches may still be visible through the tours listener.
            </Alert>
          ) : null}

          {visibleSafetyAlerts.length > 0 ? (
            <Stack gap="xs">
              {visibleSafetyAlerts.map((alert) => (
                <Paper key={alert.id} p="sm" radius="md" withBorder>
                  <Group justify="space-between" align="flex-start" gap="sm">
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Group gap="xs" mb={4}>
                        <SafetyBadge value={alert.severity} />
                        <SafetyBadge value={alert.status} kind="status" />
                        {alert.isSOS ? <Badge color="red" variant="filled">SOS</Badge> : null}
                      </Group>
                      <Text size="sm" fw={700} lineClamp={2}>{alert.message}</Text>
                      <Text size="xs" c="dimmed">
                        {alert.tourId ? `Tour ${alert.tourId}` : 'No tour attached'} - {alert.role || 'role unknown'} - {formatDateTimeForDisplay(alert.timestampMs, 'time unknown')}
                      </Text>
                    </Box>
                    <Group gap={6} wrap="nowrap">
                      {alert.tourId ? (
                        <Tooltip label="Open tour">
                          <ActionIcon variant="light" color="blue" onClick={() => openToursUrl(navigate, { q: alert.tourId })}>
                            <IconExternalLink size={15} />
                          </ActionIcon>
                        </Tooltip>
                      ) : null}
                      {alert.status === SAFETY_STATUS.PENDING ? (
                        <Tooltip label="Acknowledge safety alert">
                          <ActionIcon
                            variant="light"
                            color="yellow"
                            loading={mutatingSafetyId === alert.id}
                            onClick={() => handleSafetyAction(alert, SAFETY_STATUS.ACKNOWLEDGED)}
                          >
                            <IconCheck size={15} />
                          </ActionIcon>
                        </Tooltip>
                      ) : null}
                      {alert.status !== SAFETY_STATUS.RESOLVED ? (
                        <Tooltip label="Resolve safety alert">
                          <ActionIcon
                            variant="light"
                            color="green"
                            loading={mutatingSafetyId === alert.id}
                            onClick={() => handleSafetyAction(alert, SAFETY_STATUS.RESOLVED)}
                          >
                            <IconCircleCheck size={15} />
                          </ActionIcon>
                        </Tooltip>
                      ) : (
                        <Badge color="green" variant="light">Closed</Badge>
                      )}
                    </Group>
                  </Group>
                </Paper>
              ))}
            </Stack>
          ) : (
            <EmptyState
              title="No matching safety alerts"
              description="No sanitized safety alert records match the current status filter."
            />
          )}
        </Card>

        <Card shadow="sm" padding="md" radius="md" withBorder>
          <PanelHeader
            icon={IconSpeakerphone}
            title="Broadcast Activity"
            description="Recent admin broadcasts from the broadcasts root. Author UIDs are intentionally not shown."
            right={(
              <Button
                size="xs"
                leftSection={<IconMessageCircle size={14} />}
                onClick={() => navigate('/broadcast')}
              >
                Compose
              </Button>
            )}
          />

          {branchErrors.broadcasts ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="md">
              Broadcast activity could not be loaded.
            </Alert>
          ) : null}

          <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm" mb="md">
            <Paper p="sm" radius="md" withBorder>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Last 24h</Text>
              <Text fw={800}>{formatCount(broadcastActivity.last24hCount)}</Text>
            </Paper>
            <Paper p="sm" radius="md" withBorder>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Loaded</Text>
              <Text fw={800}>{formatCount(broadcastActivity.totalCount)}</Text>
            </Paper>
            <Paper p="sm" radius="md" withBorder>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Tours</Text>
              <Text fw={800}>{formatCount(broadcastActivity.tourCount)}</Text>
            </Paper>
          </SimpleGrid>

          {broadcastActivity.recent.length > 0 ? (
            <Stack gap="xs">
              {broadcastActivity.recent.map((broadcast) => (
                <Paper key={broadcast.id} p="sm" radius="md" withBorder>
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Group gap="xs">
                        <Badge size="sm" color="orange" variant="light">{broadcast.tourId}</Badge>
                        <Text size="xs" c="dimmed">{broadcast.source}</Text>
                      </Group>
                      <Text size="sm" mt={4} lineClamp={2}>{broadcast.message}</Text>
                    </Box>
                    <Stack gap={4} align="flex-end">
                      <Text size="xs" c="dimmed">
                        {formatDateTimeForDisplay(broadcast.timestampMs, 'unknown')}
                      </Text>
                      <Tooltip label="Open tour">
                        <ActionIcon variant="light" size="sm" onClick={() => openToursUrl(navigate, { q: broadcast.tourId })}>
                          <IconExternalLink size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Stack>
                  </Group>
                </Paper>
              ))}
            </Stack>
          ) : (
            <EmptyState
              icon={IconSpeakerphone}
              color="gray"
              title="No broadcasts loaded"
              description="No broadcast records are present in the loaded Firebase branch."
            />
          )}
        </Card>
      </SimpleGrid>

      <Card shadow="sm" padding="md" radius="md" withBorder>
        <PanelHeader
          icon={IconCalendar}
          title="Realtime And Backend Sync Health"
          description="Health uses the shared LLT sync taxonomy and the actual listener state for each dashboard branch."
          right={(
            <Badge variant="light" color={healthSnapshot.color}>
              {healthSnapshot.label}
            </Badge>
          )}
        />

        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="sm" mb="md">
          {syncSummaryCards.map((status) => {
            const Icon = status.icon;
            return (
              <Paper key={status.label} p="sm" radius="md" withBorder>
                <Group wrap="nowrap">
                  <ThemeIcon color={status.color} variant="light" size="md" radius="md">
                    <Icon size={15} />
                  </ThemeIcon>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={600}>{status.label}</Text>
                    <Text size="xs" c="dimmed">{status.description}</Text>
                  </Box>
                  <Badge size="sm" color={status.color} variant="light">{status.value}</Badge>
                </Group>
              </Paper>
            );
          })}
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="sm">
          {branchKeys.map((branchKey) => (
            <BranchHealthRow
              key={branchKey}
              branchKey={branchKey}
              loading={branchLoading[branchKey]}
              error={branchErrors[branchKey]}
              syncedAt={branchSyncedAt[branchKey]}
            />
          ))}
        </SimpleGrid>

        <Divider my="md" />
        <Group gap="xs" wrap="wrap">
          <Badge color="gray" variant="outline">{HEALTH_STATE.OFFLINE_NO_NETWORK}</Badge>
          <Badge color="gray" variant="outline">{HEALTH_STATE.ONLINE_BACKEND_DEGRADED}</Badge>
          <Badge color="gray" variant="outline">{HEALTH_STATE.ONLINE_BACKLOG_PENDING}</Badge>
          <Badge color="gray" variant="outline">{HEALTH_STATE.ONLINE_HEALTHY}</Badge>
        </Group>
      </Card>
    </Stack>
  );
}
