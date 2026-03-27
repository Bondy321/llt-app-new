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

export default function Dashboard() {
  const navigate = useNavigate();
  const [drivers, setDrivers] = useState({});
  const [tours, setTours] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg">
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
          title="Unassigned Tours"
          value={Math.max(totalTours - assignedTours, 0)}
          icon={IconAlertTriangle}
          color="red"
          subtitle="Requires dispatch assignment"
        />
      </SimpleGrid>

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
