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
  RingProgress,
  Center,
  Loader,
  Box,
  Table,
  ScrollArea,
  Avatar,
  Divider,
  ActionIcon,
  Tooltip,
  Button,
} from '@mantine/core';
import {
  IconUsers,
  IconMap,
  IconBus,
  IconMessageCircle,
  IconTrendingUp,
  IconClock,
  IconCalendar,
  IconRefresh,
  IconArrowUpRight,
  IconArrowDownRight,
  IconActivity,
  IconRoute,
} from '@tabler/icons-react';

// Stat Card Component
function StatCard({ title, value, icon, color, description, trend, trendValue }) {
  const Icon = icon;
  return (
    <Card shadow="sm" padding="lg" radius="md" withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            {title}
          </Text>
          <Title order={2} mt={4}>
            {value}
          </Title>
          {description && (
            <Text size="xs" c="dimmed" mt={4}>
              {description}
            </Text>
          )}
        </div>
        <ThemeIcon
          color={color}
          variant="light"
          size={48}
          radius="md"
        >
          <Icon size={24} stroke={1.5} />
        </ThemeIcon>
      </Group>
      {trend && (
        <Group mt="md" gap="xs">
          <ThemeIcon
            color={trend === 'up' ? 'teal' : 'red'}
            variant="light"
            size="sm"
            radius="xl"
          >
            {trend === 'up' ? <IconArrowUpRight size={14} /> : <IconArrowDownRight size={14} />}
          </ThemeIcon>
          <Text size="xs" c={trend === 'up' ? 'teal' : 'red'} fw={500}>
            {trendValue}
          </Text>
          <Text size="xs" c="dimmed">vs last week</Text>
        </Group>
      )}
    </Card>
  );
}

// Activity Item Component
function ActivityItem({ driver, tour, time, type }) {
  const getActivityColor = (type) => {
    switch (type) {
      case 'assigned': return 'green';
      case 'completed': return 'blue';
      case 'started': return 'orange';
      default: return 'gray';
    }
  };

  const getActivityLabel = (type) => {
    switch (type) {
      case 'assigned': return 'Assigned to tour';
      case 'completed': return 'Completed tour';
      case 'started': return 'Started tour';
      default: return 'Activity';
    }
  };

  return (
    <Group gap="sm" py="xs">
      <Avatar size="sm" radius="xl" color={getActivityColor(type)}>
        {driver?.charAt(0) || '?'}
      </Avatar>
      <Box style={{ flex: 1 }}>
        <Text size="sm" fw={500}>
          {driver || 'Unknown Driver'}
        </Text>
        <Text size="xs" c="dimmed">
          {getActivityLabel(type)} {tour}
        </Text>
      </Box>
      <Badge size="xs" variant="light" color={getActivityColor(type)}>
        {time}
      </Badge>
    </Group>
  );
}

// Main Dashboard Component
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

    // Subscribe to drivers
    const driversRef = ref(db, 'drivers');
    const unsubDrivers = onValue(
      driversRef,
      (snapshot) => {
        setDrivers(snapshot.val() || {});
        updateLastSync();
      },
      registerListenerError,
    );

    // Subscribe to tours
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

  // Calculate statistics
  const totalDrivers = Object.keys(drivers).length;
  const totalTours = Object.keys(tours).length;

  // Count active drivers (currentTourId canonical, with activeTourId legacy read fallback)
  const activeDrivers = Object.values(drivers).filter((d) => !!resolveCurrentTourId(d)).length;

  // Count assigned tours (those with a driver other than TBA)
  const assignedTours = Object.values(tours).filter(t => t.driverName && t.driverName !== 'TBA').length;

  // Calculate driver utilization
  const driverUtilization = totalDrivers > 0 ? Math.round((activeDrivers / totalDrivers) * 100) : 0;

  // Calculate tour assignment rate
  const tourAssignmentRate = totalTours > 0 ? Math.round((assignedTours / totalTours) * 100) : 0;

  // Get recent drivers (newest first based on createdAt)
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

  // Get today's date for display
  const today = formatLongDateForDisplay(new Date(), '-');

  if (loading) {
    return (
      <Center style={{ minHeight: 400 }}>
        <Stack align="center" gap="md">
          <Loader size="lg" color="brand" />
          <Text c="dimmed">Loading dashboard...</Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Group justify="space-between" mb="xl">
        <div>
          <Title order={2}>Dashboard</Title>
          <Text c="dimmed" size="sm">{today}</Text>
        </div>
        <Tooltip label="Refresh data">
          <ActionIcon
            variant="light"
            size="lg"
            onClick={handleRefresh}
            loading={refreshing}
          >
            <IconRefresh size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* Stats Grid */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg" mb="xl">
        <StatCard
          title="Total Drivers"
          value={totalDrivers}
          icon={IconUsers}
          color="blue"
          description={`${activeDrivers} currently active`}
          trend="up"
          trendValue="+12%"
        />
        <StatCard
          title="Total Tours"
          value={totalTours}
          icon={IconMap}
          color="green"
          description={`${assignedTours} with assigned drivers`}
          trend="up"
          trendValue="+8%"
        />
        <StatCard
          title="Active Now"
          value={activeDrivers}
          icon={IconBus}
          color="orange"
          description="Drivers on tour"
        />
        <StatCard
          title="Unassigned Tours"
          value={totalTours - assignedTours}
          icon={IconRoute}
          color="red"
          description="Awaiting driver assignment"
        />
      </SimpleGrid>

      {/* Secondary Stats */}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg" mb="xl">
        {/* Driver Utilization */}
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group justify="space-between" mb="md">
            <Text fw={500}>Driver Utilization</Text>
            <Badge variant="light" color="blue">{driverUtilization}%</Badge>
          </Group>
          <Group align="flex-end" gap="xs">
            <RingProgress
              size={120}
              thickness={12}
              roundCaps
              sections={[{ value: driverUtilization, color: 'blue' }]}
              label={
                <Center>
                  <ThemeIcon color="blue" variant="light" radius="xl" size="xl">
                    <IconUsers size={22} />
                  </ThemeIcon>
                </Center>
              }
            />
            <Stack gap={0} style={{ flex: 1 }}>
              <Text size="sm" c="dimmed">
                {activeDrivers} of {totalDrivers} drivers are currently on active tours
              </Text>
              <Progress.Root size="xl" mt="md">
                <Progress.Section value={driverUtilization} color="blue">
                  <Progress.Label>Active</Progress.Label>
                </Progress.Section>
                <Progress.Section value={100 - driverUtilization} color="gray.3">
                  <Progress.Label>Available</Progress.Label>
                </Progress.Section>
              </Progress.Root>
            </Stack>
          </Group>
        </Card>

        {/* Tour Assignment Rate */}
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group justify="space-between" mb="md">
            <Text fw={500}>Tour Assignment Rate</Text>
            <Badge variant="light" color="green">{tourAssignmentRate}%</Badge>
          </Group>
          <Group align="flex-end" gap="xs">
            <RingProgress
              size={120}
              thickness={12}
              roundCaps
              sections={[{ value: tourAssignmentRate, color: 'green' }]}
              label={
                <Center>
                  <ThemeIcon color="green" variant="light" radius="xl" size="xl">
                    <IconMap size={22} />
                  </ThemeIcon>
                </Center>
              }
            />
            <Stack gap={0} style={{ flex: 1 }}>
              <Text size="sm" c="dimmed">
                {assignedTours} of {totalTours} tours have drivers assigned
              </Text>
              <Progress.Root size="xl" mt="md">
                <Progress.Section value={tourAssignmentRate} color="green">
                  <Progress.Label>Assigned</Progress.Label>
                </Progress.Section>
                <Progress.Section value={100 - tourAssignmentRate} color="gray.3">
                  <Progress.Label>TBA</Progress.Label>
                </Progress.Section>
              </Progress.Root>
            </Stack>
          </Group>
        </Card>
      </SimpleGrid>

      {/* Recent Drivers & Quick Actions */}
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        {/* Priority Actions */}
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group justify="space-between" mb="md">
            <Text fw={500}>Priority Actions</Text>
            <Badge variant="light" color={unassignedUpcomingTours.length > 0 ? 'red' : 'green'}>
              {unassignedUpcomingTours.length > 0 ? `${unassignedUpcomingTours.length} urgent` : 'No urgent items'}
            </Badge>
          </Group>

          {unassignedUpcomingTours.length > 0 ? (
            <Stack gap="xs">
              {unassignedUpcomingTours.map((tour) => {
                const urgency = getUrgencyBadge(tour.dayDelta);
                return (
                  <Paper key={tour.id} p="sm" radius="md" withBorder>
                    <Group justify="space-between" align="center">
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Text fw={500} size="sm" truncate="end">{tour.name}</Text>
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
                leftSection={<IconRoute size={16} />}
                onClick={() => navigate('/tours?status=unassigned')}
              >
                Review unassigned tours
              </Button>
            </Stack>
          ) : (
            <Text c="dimmed" size="sm">
              All tours starting within 7 days currently have drivers assigned.
            </Text>
          )}
        </Card>

        {/* Recent Drivers */}
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group justify="space-between" mb="md">
            <Text fw={500}>Recent Drivers</Text>
            <Badge variant="light" color="blue">Last 5</Badge>
          </Group>
          {recentDrivers.length > 0 ? (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Driver</Table.Th>
                  <Table.Th>ID</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {recentDrivers.map(([id, driver]) => (
                  <Table.Tr key={id}>
                    <Table.Td>
                      <Group gap="xs">
                        <Avatar size="sm" radius="xl" color="brand">
                          {driver.name?.charAt(0) || '?'}
                        </Avatar>
                        <Text size="sm" fw={500}>{driver.name}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" size="sm">{id}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        variant="dot"
                        color={resolveCurrentTourId(driver) ? 'green' : 'gray'}
                        size="sm"
                      >
                        {resolveCurrentTourId(driver) ? 'Active' : 'Available'}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text c="dimmed" ta="center" py="xl">No drivers found</Text>
          )}
        </Card>

        {/* System Status */}
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group justify="space-between" mb="md">
            <Text fw={500}>System Status</Text>
            <Badge variant="light" color={healthSnapshot.color}>{healthSnapshot.label}</Badge>
          </Group>
          <Stack gap="md">
            <Paper p="sm" radius="md" bg={`${databaseConnectionStatus.color}.0`}>
              <Group gap="sm">
                <ThemeIcon color={databaseConnectionStatus.color} variant="light" size="md">
                  <IconActivity size={16} />
                </ThemeIcon>
                <div>
                  <Text size="sm" fw={500}>Database Connection</Text>
                  <Text size="xs" c="dimmed">{databaseConnectionStatus.description}</Text>
                </div>
                <Badge ml="auto" color={databaseConnectionStatus.color} variant="filled" size="sm">
                  {databaseConnectionStatus.label}
                </Badge>
              </Group>
            </Paper>
            <Paper p="sm" radius="md" bg={`${realtimeSyncStatus.color}.0`}>
              <Group gap="sm">
                <ThemeIcon color={realtimeSyncStatus.color} variant="light" size="md">
                  <IconClock size={16} />
                </ThemeIcon>
                <div>
                  <Text size="sm" fw={500}>Real-time Sync</Text>
                  <Text size="xs" c="dimmed">{realtimeSyncStatus.description}</Text>
                </div>
                <Badge ml="auto" color={realtimeSyncStatus.color} variant="filled" size="sm">
                  {realtimeSyncStatus.label}
                </Badge>
              </Group>
            </Paper>
            <Paper p="sm" radius="md" bg={`${broadcastStatus.color}.0`}>
              <Group gap="sm">
                <ThemeIcon color={broadcastStatus.color} variant="light" size="md">
                  <IconMessageCircle size={16} />
                </ThemeIcon>
                <div>
                  <Text size="sm" fw={500}>Broadcast System</Text>
                  <Text size="xs" c="dimmed">{broadcastStatus.description}</Text>
                </div>
                <Badge ml="auto" color={broadcastStatus.color} variant="filled" size="sm">
                  {broadcastStatus.label}
                </Badge>
              </Group>
            </Paper>
            <Divider my="xs" />
            <Group gap="xs">
              <IconCalendar size={14} color="gray" />
              <Text size="xs" c="dimmed">
                Last updated: {formatTimeForDisplay(healthSignals.lastSuccessfulSyncAt, 'Awaiting first sync')}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              Sync taxonomy: {HEALTH_STATE.OFFLINE_NO_NETWORK}, {HEALTH_STATE.ONLINE_BACKEND_DEGRADED},{' '}
              {HEALTH_STATE.ONLINE_BACKLOG_PENDING}, {HEALTH_STATE.ONLINE_HEALTHY}
            </Text>
          </Stack>
        </Card>
      </SimpleGrid>
    </Box>
  );
}
