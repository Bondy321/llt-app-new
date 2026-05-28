import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ref, onValue } from 'firebase/database';
import { notifications } from '@mantine/notifications';
import { db } from '../firebase';
import {
  HEALTH_STATE,
  buildDashboardStatusChips,
  buildHealthSnapshot,
  revalidateDashboardData,
} from '../services/healthService';
import {
  OPS_ALERT_SEVERITY_OPTIONS,
  OPS_ALERT_STATUS,
  OPS_ALERT_STATUS_OPTIONS,
  acknowledgeOpsAlert,
  buildOpsAlertStats,
  filterOpsAlerts,
  formatAffectedDevice,
  formatAffectedSession,
  resolveOpsAlert,
  subscribeToOpsAlerts,
} from '../services/opsAlertService';
import {
  formatDateForDisplay,
  formatLongDateForDisplay,
  formatTimeForDisplay,
  nowAsISOString,
  toEpochMsStrict,
} from '../utils/dateUtils';
import { getTriageMeta, getUrgencyBadge } from '../utils/triageUtils';
import {
  SimpleGrid,
  Card,
  Text,
  Title,
  Group,
  ThemeIcon,
  Progress,
  Stack,
  Paper,
  Badge,
  Center,
  Loader,
  Box,
  Table,
  Avatar,
  Divider,
  ActionIcon,
  Tooltip,
  Button,
  Flex,
  Select,
  ScrollArea,
  Alert,
} from '@mantine/core';
import {
  IconUsers,
  IconMap,
  IconMessageCircle,
  IconClock,
  IconCalendar,
  IconRefresh,
  IconArrowUpRight,
  IconArrowDownRight,
  IconActivity,
  IconRoute,
  IconAlertTriangle,
  IconChecklist,
  IconStars,
  IconBolt,
  IconBug,
  IconCheck,
  IconCircleCheck,
  IconDeviceMobile,
} from '@tabler/icons-react';

function ExecutiveStatCard({ title, value, icon: Icon, color, subtitle, trend }) {
  return (
    <Card shadow="sm" padding="lg" radius="lg" withBorder>
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            {title}
          </Text>
          <Title order={2}>{value}</Title>
          <Text size="xs" c="dimmed">
            {subtitle}
          </Text>
        </Stack>
        <ThemeIcon color={color} variant="light" radius="md" size={46}>
          <Icon size={22} stroke={1.7} />
        </ThemeIcon>
      </Group>

      {trend ? (
        <Group mt="md" gap="xs">
          <ThemeIcon
            color={trend.direction === 'up' ? 'teal' : 'red'}
            variant="light"
            size="sm"
            radius="xl"
          >
            {trend.direction === 'up' ? <IconArrowUpRight size={14} /> : <IconArrowDownRight size={14} />}
          </ThemeIcon>
          <Text size="xs" c={trend.direction === 'up' ? 'teal' : 'red'} fw={600}>
            {trend.label}
          </Text>
          <Text size="xs" c="dimmed">
            vs previous period
          </Text>
        </Group>
      ) : null}
    </Card>
  );
}

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

function OpsAlertBadge({ value, kind = 'severity' }) {
  const color = kind === 'status'
    ? OPS_STATUS_COLOR[value] || 'gray'
    : OPS_SEVERITY_COLOR[value] || 'gray';

  return (
    <Badge size="sm" color={color} variant={kind === 'status' ? 'light' : 'filled'}>
      {value}
    </Badge>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [drivers, setDrivers] = useState({});
  const [tours, setTours] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [opsAlerts, setOpsAlerts] = useState([]);
  const [opsAlertsLoading, setOpsAlertsLoading] = useState(true);
  const [opsAlertsError, setOpsAlertsError] = useState(null);
  const [opsSeverityFilter, setOpsSeverityFilter] = useState('all');
  const [opsStatusFilter, setOpsStatusFilter] = useState('active');
  const [mutatingAlertId, setMutatingAlertId] = useState(null);
  const [healthSignals, setHealthSignals] = useState({
    isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    listenerConnected: true,
    listenerErrorCount: 0,
    pendingFailedOperations: 0,
    backlogPendingCount: 0,
    lastSuccessfulSyncAt: null,
  });

  const healthSnapshot = useMemo(() => buildHealthSnapshot(healthSignals), [healthSignals]);
  const statusChips = useMemo(() => buildDashboardStatusChips(healthSnapshot), [healthSnapshot]);
  const databaseConnectionStatus = statusChips.DATABASE_CONNECTION;
  const realtimeSyncStatus = statusChips.REALTIME_SYNC;
  const broadcastStatus = statusChips.BROADCAST_SYSTEM;
  const opsAlertStats = useMemo(() => buildOpsAlertStats(opsAlerts), [opsAlerts]);
  const visibleOpsAlerts = useMemo(() => filterOpsAlerts(opsAlerts, {
    severity: opsSeverityFilter,
    status: opsStatusFilter,
  }).slice(0, 10), [opsAlerts, opsSeverityFilter, opsStatusFilter]);

  useEffect(() => {
    const updateLastSync = () => {
      setHealthSignals((current) => ({
        ...current,
        lastSuccessfulSyncAt: nowAsISOString(),
        listenerConnected: true,
      }));
    };

    const registerListenerError = () => {
      setHealthSignals((current) => ({
        ...current,
        listenerErrorCount: current.listenerErrorCount + 1,
        listenerConnected: false,
        pendingFailedOperations: current.pendingFailedOperations + 1,
      }));
    };

    const driversRef = ref(db, 'drivers');
    const unsubDrivers = onValue(
      driversRef,
      (snapshot) => {
        setDrivers(snapshot.val() || {});
        updateLastSync();
      },
      registerListenerError,
    );

    const toursRef = ref(db, 'tours');
    const unsubTours = onValue(
      toursRef,
      (snapshot) => {
        setTours(snapshot.val() || {});
        setLoading(false);
        updateLastSync();
      },
      (error) => {
        setLoading(false);
        registerListenerError(error);
      },
    );

    const unsubOpsAlerts = subscribeToOpsAlerts(
      db,
      { orderBy: 'lastSeenAtMs', limit: 80 },
      (alerts) => {
        setOpsAlerts(alerts);
        setOpsAlertsLoading(false);
        setOpsAlertsError(null);
        updateLastSync();
      },
      (error) => {
        setOpsAlertsLoading(false);
        setOpsAlertsError(error);
        registerListenerError(error);
      },
    );

    const handleOnline = () => {
      setHealthSignals((current) => ({ ...current, isOnline: true, listenerConnected: true }));
    };

    const handleOffline = () => {
      setHealthSignals((current) => ({ ...current, isOnline: false, listenerConnected: false }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      unsubDrivers();
      unsubTours();
      unsubOpsAlerts();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await revalidateDashboardData(db);
      setDrivers(result.drivers);
      setTours(result.tours);
      setHealthSignals((current) => ({
        ...current,
        isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
        listenerConnected: true,
        pendingFailedOperations: 0,
        backlogPendingCount: 0,
        lastSuccessfulSyncAt: result.revalidatedAt,
      }));
      notifications.show({
        title: 'Dashboard refreshed',
        message: 'Live data revalidated from Firebase successfully.',
        color: 'green',
      });
    } catch {
      setHealthSignals((current) => ({
        ...current,
        pendingFailedOperations: current.pendingFailedOperations + 1,
        backlogPendingCount: current.backlogPendingCount + 1,
      }));
      notifications.show({
        title: 'Refresh failed',
        message: 'Unable to revalidate dashboard data from Firebase.',
        color: 'red',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleOpsAlertAction = async (alertId, action) => {
    setMutatingAlertId(alertId);
    try {
      if (action === 'resolve') {
        await resolveOpsAlert(db, alertId);
      } else {
        await acknowledgeOpsAlert(db, alertId);
      }

      notifications.show({
        title: action === 'resolve' ? 'Alert resolved' : 'Alert acknowledged',
        message: 'The operations alert status was updated.',
        color: action === 'resolve' ? 'green' : 'yellow',
      });
    } catch {
      notifications.show({
        title: 'Alert update failed',
        message: 'Unable to update the operations alert status.',
        color: 'red',
      });
    } finally {
      setMutatingAlertId(null);
    }
  };

  const resolveCurrentTourId = (driver) => driver?.currentTourId || driver?.activeTourId || '';

  const totalDrivers = Object.keys(drivers).length;
  const totalTours = Object.keys(tours).length;
  const activeDrivers = Object.values(drivers).filter((d) => !!resolveCurrentTourId(d)).length;
  const assignedTours = Object.values(tours).filter((tour) => tour.driverName && tour.driverName !== 'TBA').length;

  const driverUtilization = totalDrivers > 0 ? Math.round((activeDrivers / totalDrivers) * 100) : 0;
  const tourAssignmentRate = totalTours > 0 ? Math.round((assignedTours / totalTours) * 100) : 0;

  const toursWithPassengers = Object.values(tours).filter((tour) => (tour.currentParticipants || 0) > 0);
  const totalPassengers = toursWithPassengers.reduce((sum, tour) => sum + (tour.currentParticipants || 0), 0);
  const averagePassengersPerActiveTour = toursWithPassengers.length
    ? Math.round(totalPassengers / toursWithPassengers.length)
    : 0;

  const recentDrivers = Object.entries(drivers)
    .sort((a, b) => {
      const dateA = toEpochMsStrict(a[1].createdAt) ?? 0;
      const dateB = toEpochMsStrict(b[1].createdAt) ?? 0;
      return dateB - dateA;
    })
    .slice(0, 5);

  const unassignedUpcomingTours = useMemo(() => {
    return Object.entries(tours)
      .map(([id, tour]) => {
        const isAssigned = tour.driverName && tour.driverName !== 'TBA';
        if (isAssigned) return null;

        const triage = getTriageMeta(tour.startDate);
        if (!triage) return null;

        return {
          id,
          name: tour.name || id,
          startDate: tour.startDate,
          participants: tour.currentParticipants || 0,
          dayDelta: triage.dayDelta,
          parsedDate: triage.parsedDate,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.parsedDate - b.parsedDate)
      .slice(0, 5);
  }, [tours]);

  const operationalReadiness = Math.round((driverUtilization * 0.45 + tourAssignmentRate * 0.55) || 0);

  const today = formatLongDateForDisplay(new Date(), '-');

  if (loading) {
    return (
      <Center style={{ minHeight: 420 }}>
        <Stack align="center" gap="md">
          <Loader size="lg" color="brand" />
          <Text c="dimmed">Preparing your dispatch command center…</Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap="xl">
      <Card
        withBorder
        radius="xl"
        p="xl"
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-blue-9) 0%, var(--mantine-color-indigo-6) 55%, var(--mantine-color-cyan-6) 100%)',
        }}
      >
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="lg">
          <Stack gap={6}>
            <Group gap="xs">
              <ThemeIcon color="white" variant="light" size="md" radius="xl">
                <IconStars size={16} />
              </ThemeIcon>
              <Text size="xs" fw={700} c="white" style={{ letterSpacing: 0.8 }}>
                OPERATIONS OVERVIEW
              </Text>
            </Group>
            <Title order={2} c="white">
              Dispatch Intelligence Dashboard
            </Title>
            <Text c="rgba(255,255,255,0.9)" maw={680}>
              Unified real-time operations insight for LLT tours, staffing coverage, and health telemetry.
            </Text>
            <Group gap="sm" mt="xs">
              <Badge color={healthSnapshot.color} variant="white">
                {healthSnapshot.label}
              </Badge>
              <Badge color="white" variant="dot">
                {today}
              </Badge>
              <Badge color="white" variant="dot">
                Last sync {formatTimeForDisplay(healthSignals.lastSuccessfulSyncAt, 'pending')}
              </Badge>
            </Group>
          </Stack>

          <Flex align="center" gap="sm">
            <Tooltip label="Refresh data">
              <ActionIcon variant="white" size="xl" onClick={handleRefresh} loading={refreshing}>
                <IconRefresh size={20} />
              </ActionIcon>
            </Tooltip>
            <Button
              variant="white"
              leftSection={<IconRoute size={16} />}
              onClick={() => navigate('/tours?status=unassigned')}
            >
              Dispatch Queue
            </Button>
          </Flex>
        </Group>
      </Card>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} spacing="lg">
        <ExecutiveStatCard
          title="Total Drivers"
          value={totalDrivers}
          icon={IconUsers}
          color="blue"
          subtitle={`${activeDrivers} currently active on route`}
          trend={{ direction: 'up', label: '+12%' }}
        />
        <ExecutiveStatCard
          title="Total Tours"
          value={totalTours}
          icon={IconMap}
          color="teal"
          subtitle={`${assignedTours} with assigned drivers`}
          trend={{ direction: 'up', label: '+8%' }}
        />
        <ExecutiveStatCard
          title="Operational Readiness"
          value={`${operationalReadiness}%`}
          icon={IconBolt}
          color="violet"
          subtitle="Weighted by assignment coverage and active staffing"
        />
        <ExecutiveStatCard
          title="Critical App Errors"
          value={opsAlertStats.openCriticalCount}
          icon={IconBug}
          color={opsAlertStats.openCriticalCount > 0 ? 'red' : 'green'}
          subtitle={`${opsAlertStats.activeCount} active device/app alerts`}
        />
        <ExecutiveStatCard
          title="Unassigned Tours"
          value={Math.max(totalTours - assignedTours, 0)}
          icon={IconAlertTriangle}
          color="red"
          subtitle="Requires dispatch assignment"
        />
      </SimpleGrid>

      <Card shadow="sm" padding="lg" radius="lg" withBorder>
        <Group justify="space-between" align="flex-start" mb="md" gap="md">
          <Stack gap={4}>
            <Group gap="xs">
              <ThemeIcon color={opsAlertStats.openCriticalCount > 0 ? 'red' : 'green'} variant="light" size="md" radius="md">
                <IconDeviceMobile size={16} />
              </ThemeIcon>
              <Title order={4}>Operations / Health / Errors</Title>
            </Group>
            <Text size="sm" c="dimmed">
              Live curated device and app failures from mobile diagnostics.
            </Text>
          </Stack>

          <Group gap="xs" wrap="wrap" justify="flex-end">
            <Badge color={opsAlertsError ? 'red' : 'green'} variant="light">
              {opsAlertsError ? 'Degraded' : 'Live'}
            </Badge>
            <Badge color={opsAlertStats.openCriticalCount > 0 ? 'red' : 'gray'} variant="filled">
              {opsAlertStats.openCriticalCount} critical
            </Badge>
            <Badge color={opsAlertStats.openErrorCount > 0 ? 'orange' : 'gray'} variant="light">
              {opsAlertStats.openErrorCount} open major
            </Badge>
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 1, md: 4 }} spacing="sm" mb="md">
          <Paper p="sm" radius="md" withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Active alerts</Text>
            <Text fw={800} size="xl">{opsAlertStats.activeCount}</Text>
          </Paper>
          <Paper p="sm" radius="md" withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Critical open</Text>
            <Text fw={800} size="xl" c={opsAlertStats.openCriticalCount > 0 ? 'red' : 'green'}>
              {opsAlertStats.openCriticalCount}
            </Text>
          </Paper>
          <Paper p="sm" radius="md" withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Top component</Text>
            <Text fw={700} size="sm" truncate="end">
              {Object.entries(opsAlertStats.byComponent).sort((a, b) => b[1] - a[1])[0]?.[0] || 'None'}
            </Text>
          </Paper>
          <Paper p="sm" radius="md" withBorder>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Most severe</Text>
            <Text fw={700} size="sm" truncate="end">
              {opsAlertStats.mostSevereActiveAlert?.component || 'No active alerts'}
            </Text>
          </Paper>
        </SimpleGrid>

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
            Showing {visibleOpsAlerts.length} of {opsAlerts.length} recent curated alerts
          </Text>
        </Group>

        {opsAlertsError ? (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="md">
            Device/app error alerts are temporarily unavailable. Driver and tour listeners remain separate.
          </Alert>
        ) : null}

        {opsAlertsLoading ? (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <Loader size="md" color="brand" />
              <Text size="sm" c="dimmed">Loading live device/app alerts...</Text>
            </Stack>
          </Center>
        ) : visibleOpsAlerts.length > 0 ? (
          <ScrollArea type="auto">
            <Table highlightOnHover verticalSpacing="sm" miw={980}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Severity</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Component / source</Table.Th>
                  <Table.Th>Message</Table.Th>
                  <Table.Th>Affected device/session</Table.Th>
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
                      <Text size="xs" fw={600} truncate="end" maw={220}>
                        {formatAffectedDevice(alert)}
                      </Text>
                      <Text size="xs" c="dimmed" truncate="end" maw={220}>
                        {formatAffectedSession(alert)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={600}>{formatTimeForDisplay(alert.lastSeenAtMs, 'unknown')}</Text>
                      <Text size="xs" c="dimmed">Seen {alert.count}x</Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
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
          <Center py="xl">
            <Stack align="center" gap="xs">
              <ThemeIcon color="green" variant="light" size="lg" radius="xl">
                <IconCircleCheck size={18} />
              </ThemeIcon>
              <Text size="sm" fw={600}>No matching device/app alerts</Text>
              <Text size="xs" c="dimmed" ta="center" maw={320}>
                The curated operations alert stream is clear for the current filters.
              </Text>
            </Stack>
          </Center>
        )}
      </Card>

      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="lg">
        <Card shadow="sm" padding="lg" radius="lg" withBorder>
          <Group justify="space-between" mb="md">
            <Text fw={600}>Resource Utilization</Text>
            <Badge variant="light" color="blue">
              Live
            </Badge>
          </Group>

          <Stack gap="md">
            <Box>
              <Group justify="space-between" mb={6}>
                <Text size="sm" fw={500}>Driver utilization</Text>
                <Text size="sm" c="dimmed">{driverUtilization}%</Text>
              </Group>
              <Progress value={driverUtilization} color="blue" radius="xl" size="lg" />
            </Box>

            <Box>
              <Group justify="space-between" mb={6}>
                <Text size="sm" fw={500}>Tour assignment rate</Text>
                <Text size="sm" c="dimmed">{tourAssignmentRate}%</Text>
              </Group>
              <Progress value={tourAssignmentRate} color="green" radius="xl" size="lg" />
            </Box>

            <Divider />

            <Group justify="space-between">
              <Text size="sm" c="dimmed">Passengers on active tours</Text>
              <Text fw={700}>{totalPassengers}</Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">Avg passengers / active tour</Text>
              <Text fw={700}>{averagePassengersPerActiveTour}</Text>
            </Group>
          </Stack>
        </Card>

        <Card shadow="sm" padding="lg" radius="lg" withBorder>
          <Group justify="space-between" mb="md">
            <Text fw={600}>Dispatch Priority Queue</Text>
            <Badge variant="light" color={unassignedUpcomingTours.length > 0 ? 'red' : 'green'}>
              {unassignedUpcomingTours.length > 0 ? `${unassignedUpcomingTours.length} pending` : 'All covered'}
            </Badge>
          </Group>

          {unassignedUpcomingTours.length > 0 ? (
            <Stack gap="xs">
              {unassignedUpcomingTours.map((tour) => {
                const urgency = getUrgencyBadge(tour.dayDelta);
                return (
                  <Paper key={tour.id} p="sm" radius="md" withBorder>
                    <Group justify="space-between" align="center" wrap="nowrap">
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Text fw={600} size="sm" truncate="end">{tour.name}</Text>
                        <Text size="xs" c="dimmed">
                          Starts {formatDateForDisplay(tour.startDate)} • {tour.participants} passengers
                        </Text>
                      </Box>
                      <Badge size="sm" color={urgency.color} variant="filled">
                        {urgency.label}
                      </Badge>
                    </Group>
                  </Paper>
                );
              })}
              <Button
                mt="sm"
                variant="light"
                color="red"
                leftSection={<IconChecklist size={16} />}
                onClick={() => navigate('/tours?status=unassigned')}
              >
                Review and assign tours
              </Button>
            </Stack>
          ) : (
            <Center py="xl">
              <Stack align="center" gap="xs">
                <ThemeIcon size="lg" radius="xl" color="green" variant="light">
                  <IconChecklist size={18} />
                </ThemeIcon>
                <Text size="sm" fw={600}>Dispatch queue is clear</Text>
                <Text size="xs" c="dimmed" ta="center" maw={260}>
                  Every upcoming tour in the next 7 days currently has a confirmed driver assignment.
                </Text>
              </Stack>
            </Center>
          )}
        </Card>

        <Card shadow="sm" padding="lg" radius="lg" withBorder>
          <Group justify="space-between" mb="md">
            <Text fw={600}>System Health</Text>
            <Badge variant="light" color={healthSnapshot.color}>{healthSnapshot.label}</Badge>
          </Group>

          <Stack gap="sm">
            {[databaseConnectionStatus, realtimeSyncStatus, broadcastStatus].map((status, index) => {
              const Icon = index === 0 ? IconActivity : index === 1 ? IconClock : IconMessageCircle;
              const label = index === 0 ? 'Database connection' : index === 1 ? 'Realtime sync' : 'Broadcast system';
              return (
                <Paper key={label} p="sm" radius="md" withBorder bg={`${status.color}.0`}>
                  <Group wrap="nowrap" align="center">
                    <ThemeIcon color={status.color} variant="light" size="md" radius="md">
                      <Icon size={15} />
                    </ThemeIcon>
                    <Box style={{ flex: 1 }}>
                      <Text size="sm" fw={500}>{label}</Text>
                      <Text size="xs" c="dimmed">{status.description}</Text>
                    </Box>
                    <Badge size="sm" color={status.color} variant="filled">{status.label}</Badge>
                  </Group>
                </Paper>
              );
            })}

            <Divider my="xs" />
            <Group gap="xs">
              <IconCalendar size={14} color="gray" />
              <Text size="xs" c="dimmed">
                Last successful sync: {formatTimeForDisplay(healthSignals.lastSuccessfulSyncAt, 'Awaiting first sync')}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              Taxonomy: {HEALTH_STATE.OFFLINE_NO_NETWORK}, {HEALTH_STATE.ONLINE_BACKEND_DEGRADED},{' '}
              {HEALTH_STATE.ONLINE_BACKLOG_PENDING}, {HEALTH_STATE.ONLINE_HEALTHY}
            </Text>
          </Stack>
        </Card>
      </SimpleGrid>

      <Card shadow="sm" padding="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="md">
          <Title order={4}>Recently Added Drivers</Title>
          <Badge variant="light" color="blue">Last 5</Badge>
        </Group>

        {recentDrivers.length > 0 ? (
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Driver</Table.Th>
                <Table.Th>Driver ID</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Current Tour</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {recentDrivers.map(([id, driver]) => {
                const currentTour = resolveCurrentTourId(driver);
                return (
                  <Table.Tr key={id}>
                    <Table.Td>
                      <Group gap="xs">
                        <Avatar size="sm" radius="xl" color="brand">
                          {driver.name?.charAt(0) || '?'}
                        </Avatar>
                        <Text size="sm" fw={600}>{driver.name || 'Unnamed Driver'}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" size="sm">{id}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="dot" color={currentTour ? 'green' : 'gray'} size="sm">
                        {currentTour ? 'On tour' : 'Available'}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c={currentTour ? 'dark' : 'dimmed'}>
                        {currentTour || '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        ) : (
          <Center py="xl">
            <Text c="dimmed" size="sm">No drivers found in the current environment.</Text>
          </Center>
        )}
      </Card>
    </Stack>
  );
}
