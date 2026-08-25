import { ActionIcon, Alert, Badge, Box, Button, Card, Center, Divider, Flex, Group, Loader, Paper, Progress, ScrollArea, Select, SimpleGrid, Stack, Table, Text, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { IconActivity, IconAlertTriangle, IconBolt, IconBug, IconCalendar, IconCheck, IconChecklist, IconCircleCheck, IconDeviceMobile, IconExternalLink, IconInfoCircle, IconMap, IconMessageCircle, IconRefresh, IconRoute, IconShieldCheck, IconSpeakerphone, IconUsers } from '@tabler/icons-react';
import { HEALTH_STATE } from '../../../services/healthService';
import { SAFETY_STATUS, SAFETY_STATUS_OPTIONS } from '../../../services/dashboardService';
import { OPS_ALERT_SEVERITY_OPTIONS, OPS_ALERT_STATUS, OPS_ALERT_STATUS_OPTIONS, formatAffectedDevice, formatAffectedSession } from '../../../services/opsAlertService';
import { formatDateForDisplay, formatDateTimeForDisplay, formatTimeForDisplay } from '../../../utils/dateUtils';
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
import { BranchHealthRow, EmptyState, MetricCard, OpsAlertBadge, PanelHeader, SafetyBadge } from './DashboardComponents';
export default function DashboardView(props) {
  const {
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
  } = props;
  return <Stack gap="lg">
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
            <Button variant="light" leftSection={<IconRoute size={16} />} onClick={() => openToursUrl(navigate, {
            status: 'unassigned'
          })}>
              Unassigned tours
            </Button>
            <Button leftSection={<IconSpeakerphone size={16} />} onClick={() => navigate('/broadcast')}>
              Broadcast
            </Button>
          </Flex>
        </Group>
      </Card>

      <SimpleGrid cols={{
      base: 1,
      sm: 2,
      lg: 3
    }} spacing="md">
        <MetricCard title="Critical App Errors" value={formatCount(opsAlertStats.openCriticalCount)} icon={IconBug} color={opsAlertStats.openCriticalCount > 0 ? 'red' : 'green'} subtitle={`${formatCount(opsAlertStats.activeCount)} active app/device alerts`} detail={`${formatCount(opsAlertStats.openErrorCount)} open critical/error alerts`} />
        <MetricCard title="Driver Coverage" value={formatPercent(metrics.upcomingAssignmentCoveragePercent)} icon={IconUsers} color={metrics.unassignedUpcomingTours > 0 ? 'orange' : 'green'} subtitle={`${formatCount(metrics.assignedUpcomingTours)} of ${formatCount(metrics.upcomingTours)} upcoming dated tours assigned`} detail={`${formatCount(metrics.availableDrivers)} drivers without a current assignment`} />
        <MetricCard title="Unassigned Queue" value={formatCount(metrics.unassignedUpcomingTours)} icon={IconChecklist} color={metrics.unassignedUpcomingTours > 0 ? 'red' : 'green'} subtitle="Active tours due soon or recently overdue" detail={`${formatCount(metrics.missingDateOperationalTours)} active tours have no valid start date`} />
        <MetricCard title="Passenger Load" value={formatPercent(metrics.passengerLoadPercent, formatCount(metrics.totalPassengers))} icon={IconBolt} color={metrics.highLoadTours > 0 ? 'orange' : 'blue'} subtitle={`${formatCount(metrics.totalPassengers)} passengers / ${formatCount(metrics.totalKnownCapacity)} known seats`} detail={`${formatCount(metrics.unknownCapacityTours)} active tours missing capacity`} />
        <MetricCard title="Safety Attention" value={formatCount(metrics.safetyAttentionAlerts)} icon={IconShieldCheck} color={metrics.safetyAttentionAlerts > 0 ? 'red' : 'green'} subtitle="Pending, acknowledged, in-progress, or escalated alerts" detail={`${formatCount(dashboardModel.safetyAlerts.length)} safety alerts loaded`} />
        <MetricCard title="Broadcast Activity" value={formatCount(broadcastActivity.last24hCount)} icon={IconSpeakerphone} color="orange" subtitle={`${formatCount(broadcastActivity.totalCount)} broadcasts loaded across ${formatCount(broadcastActivity.tourCount)} tours`} detail={`Last sent ${formatDateTimeForDisplay(broadcastActivity.lastBroadcastAtMs, 'not available')}`} />
      </SimpleGrid>

      <Card shadow="sm" padding="md" radius="md" withBorder>
        <PanelHeader icon={IconDeviceMobile} title="Operations / Health / Errors" description="Curated mobile app and device failures from ops_alerts. Raw logs are not read here." right={<Group gap="xs" justify="flex-end">
              <Badge color={opsAlertsError ? 'red' : branchLoading.opsAlerts ? 'yellow' : 'green'} variant="light">
                {opsAlertsError ? 'Degraded' : branchLoading.opsAlerts ? 'Loading' : 'Loaded'}
              </Badge>
              <Badge color={opsAlertStats.openCriticalCount > 0 ? 'red' : 'gray'} variant="filled">
                {formatCount(opsAlertStats.openCriticalCount)} critical
              </Badge>
            </Group>} />

        <Group justify="space-between" mb="md" align="flex-end" wrap="wrap">
          <Group gap="sm">
            <Select label="Severity" data={OPS_ALERT_SEVERITY_OPTIONS} value={opsSeverityFilter} onChange={value => setOpsSeverityFilter(value || 'all')} w={180} allowDeselect={false} />
            <Select label="Status" data={OPS_ALERT_STATUS_OPTIONS} value={opsStatusFilter} onChange={value => setOpsStatusFilter(value || 'active')} w={190} allowDeselect={false} />
          </Group>
          <Text size="xs" c="dimmed">
            Showing {formatCount(visibleOpsAlerts.length)} of {formatCount(opsAlerts.length)} recent curated alerts
          </Text>
        </Group>

        {opsAlertsError ? <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="md">
            App/device error alerts are unavailable. Other dashboard listeners continue independently.
          </Alert> : null}

        {branchLoading.opsAlerts ? <Center py="xl">
            <Stack align="center" gap="sm">
              <Loader size="md" color="brand" />
              <Text size="sm" c="dimmed">Loading app/device alerts...</Text>
            </Stack>
          </Center> : visibleOpsAlerts.length > 0 ? <ScrollArea type="auto">
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
                {visibleOpsAlerts.map(alert => <Table.Tr key={alert.id}>
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
                        {alert.tourId ? <Tooltip label="Open tour">
                            <ActionIcon variant="light" color="blue" onClick={() => openToursUrl(navigate, {
                      q: alert.tourId
                    })}>
                              <IconExternalLink size={16} />
                            </ActionIcon>
                          </Tooltip> : null}
                        {alert.status === OPS_ALERT_STATUS.OPEN ? <Tooltip label="Acknowledge alert">
                            <ActionIcon variant="light" color="yellow" loading={mutatingAlertId === alert.id} onClick={() => handleOpsAlertAction(alert.id, 'acknowledge')}>
                              <IconCheck size={16} />
                            </ActionIcon>
                          </Tooltip> : null}
                        {alert.status !== OPS_ALERT_STATUS.RESOLVED ? <Tooltip label="Resolve alert">
                            <ActionIcon variant="light" color="green" loading={mutatingAlertId === alert.id} onClick={() => handleOpsAlertAction(alert.id, 'resolve')}>
                              <IconCircleCheck size={16} />
                            </ActionIcon>
                          </Tooltip> : <Badge color="green" variant="light">Closed</Badge>}
                      </Group>
                    </Table.Td>
                  </Table.Tr>)}
              </Table.Tbody>
            </Table>
          </ScrollArea> : <EmptyState title="No matching app/device alerts" description="The curated operations alert stream is clear for the current filters." />}

        <Divider my="md" />

        <Title order={5} mb="sm">Recent Warnings And Errors By Component</Title>
        {componentSummary.length > 0 ? <ScrollArea type="auto">
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
                {componentSummary.map(item => <Table.Tr key={item.component}>
                    <Table.Td><Text size="sm" fw={700}>{item.component}</Text></Table.Td>
                    <Table.Td><OpsAlertBadge value={item.maxSeverity} /></Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {formatCount(item.activeCount)} total - {formatCount(item.criticalCount)} critical / {formatCount(item.errorCount)} error
                      </Text>
                    </Table.Td>
                    <Table.Td><Text size="sm" lineClamp={2}>{item.latestMessage}</Text></Table.Td>
                    <Table.Td><Text size="sm">{formatDateTimeForDisplay(item.latestSeenAtMs, 'unknown')}</Text></Table.Td>
                  </Table.Tr>)}
              </Table.Tbody>
            </Table>
          </ScrollArea> : <EmptyState icon={IconInfoCircle} color="blue" title="No active warning/error components" description="No unresolved warning, error, or critical component groups are present in the loaded alert window." />}
      </Card>

      <SimpleGrid cols={{
      base: 1,
      lg: 2
    }} spacing="md">
        <Card shadow="sm" padding="md" radius="md" withBorder>
          <PanelHeader icon={IconRoute} title="Driver Assignment Coverage" description="Coverage is derived from tour driver fields, driver currentTourId, and manifest assignment links." right={<Button size="xs" variant="light" leftSection={<IconExternalLink size={14} />} onClick={() => openToursUrl(navigate, {
          status: 'unassigned'
        })}>
                Open queue
              </Button>} />

          <Stack gap="md">
            <Box>
              <Group justify="space-between" mb={6}>
                <Text size="sm" fw={600}>Upcoming dated tour coverage</Text>
                <Text size="sm" c="dimmed">{formatPercent(metrics.upcomingAssignmentCoveragePercent)}</Text>
              </Group>
              <Progress value={metrics.upcomingAssignmentCoveragePercent || 0} color={metrics.unassignedUpcomingTours > 0 ? 'orange' : 'green'} radius="xl" size="lg" />
            </Box>
            <SimpleGrid cols={{
            base: 2,
            sm: 4
          }} spacing="sm">
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

            {dashboardModel.unassignedUpcomingTours.length > 0 ? <Stack gap="xs">
                {dashboardModel.unassignedUpcomingTours.map(tour => <Paper key={tour.id} p="sm" radius="md" withBorder>
                    <Group justify="space-between" align="center" wrap="nowrap">
                      <Box style={{
                  flex: 1,
                  minWidth: 0
                }}>
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
                          <ActionIcon variant="light" onClick={() => openToursUrl(navigate, {
                      status: 'unassigned',
                      q: tour.id
                    })}>
                            <IconExternalLink size={15} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                  </Paper>)}
              </Stack> : <EmptyState title="No unassigned tours in the attention window" description="Active tours due in the configured attention window currently have driver coverage." />}
          </Stack>
        </Card>

        <Card shadow="sm" padding="md" radius="md" withBorder>
          <PanelHeader icon={IconMap} title="Passenger Load And Capacity" description="Passenger load is derived from tour counts first, then participants or manifests when needed." right={<Button size="xs" variant="light" leftSection={<IconExternalLink size={14} />} onClick={() => openToursUrl(navigate)}>
                Open tours
              </Button>} />

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
            {dashboardModel.highLoadTours.length > 0 ? <Stack gap="xs">
                {dashboardModel.highLoadTours.map(tour => <Paper key={tour.id} p="sm" radius="md" withBorder>
                    <Group justify="space-between" align="center" wrap="nowrap">
                      <Box style={{
                  flex: 1,
                  minWidth: 0
                }}>
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
                          <ActionIcon variant="light" onClick={() => openToursUrl(navigate, {
                      q: tour.id
                    })}>
                            <IconExternalLink size={15} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                  </Paper>)}
              </Stack> : <EmptyState icon={IconCircleCheck} title="No high-load tours" description="No active tour with known capacity is currently above the load threshold." />}
          </Stack>
        </Card>

        <Card shadow="sm" padding="md" radius="md" withBorder>
          <PanelHeader icon={IconShieldCheck} title="Safety Alerts Requiring Attention" description="Shows sanitized safety summaries only. User IDs, bookings, raw locations, and auth values stay hidden." right={<Select data={SAFETY_STATUS_OPTIONS} value={safetyStatusFilter} onChange={value => setSafetyStatusFilter(value || 'attention')} w={190} allowDeselect={false} />} />

          {branchErrors.globalSafetyAlerts ? <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="md">
              Global safety alerts are unavailable. Tour safety branches may still be visible through the tours listener.
            </Alert> : null}

          {visibleSafetyAlerts.length > 0 ? <Stack gap="xs">
              {visibleSafetyAlerts.map(alert => <Paper key={alert.id} p="sm" radius="md" withBorder>
                  <Group justify="space-between" align="flex-start" gap="sm">
                    <Box style={{
                flex: 1,
                minWidth: 0
              }}>
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
                      {alert.tourId ? <Tooltip label="Open tour">
                          <ActionIcon variant="light" color="blue" onClick={() => openToursUrl(navigate, {
                    q: alert.tourId
                  })}>
                            <IconExternalLink size={15} />
                          </ActionIcon>
                        </Tooltip> : null}
                      {alert.status === SAFETY_STATUS.PENDING ? <Tooltip label="Acknowledge safety alert">
                          <ActionIcon variant="light" color="yellow" loading={mutatingSafetyId === alert.id} onClick={() => handleSafetyAction(alert, SAFETY_STATUS.ACKNOWLEDGED)}>
                            <IconCheck size={15} />
                          </ActionIcon>
                        </Tooltip> : null}
                      {alert.status !== SAFETY_STATUS.RESOLVED ? <Tooltip label="Resolve safety alert">
                          <ActionIcon variant="light" color="green" loading={mutatingSafetyId === alert.id} onClick={() => handleSafetyAction(alert, SAFETY_STATUS.RESOLVED)}>
                            <IconCircleCheck size={15} />
                          </ActionIcon>
                        </Tooltip> : <Badge color="green" variant="light">Closed</Badge>}
                    </Group>
                  </Group>
                </Paper>)}
            </Stack> : <EmptyState title="No matching safety alerts" description="No sanitized safety alert records match the current status filter." />}
        </Card>

        <Card shadow="sm" padding="md" radius="md" withBorder>
          <PanelHeader icon={IconSpeakerphone} title="Broadcast Activity" description="Recent admin broadcasts from the broadcasts root. Author UIDs are intentionally not shown." right={<Button size="xs" leftSection={<IconMessageCircle size={14} />} onClick={() => navigate('/broadcast')}>
                Compose
              </Button>} />

          {branchErrors.broadcasts ? <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="md">
              Broadcast activity could not be loaded.
            </Alert> : null}

          <SimpleGrid cols={{
          base: 2,
          sm: 3
        }} spacing="sm" mb="md">
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

          {broadcastActivity.recent.length > 0 ? <Stack gap="xs">
              {broadcastActivity.recent.map(broadcast => <Paper key={broadcast.id} p="sm" radius="md" withBorder>
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <Box style={{
                flex: 1,
                minWidth: 0
              }}>
                      <Group gap="xs">
                        <Badge size="sm" color="orange" variant="light">{broadcast.tourId}</Badge>
                        <Text size="xs" c="dimmed">{broadcast.source}</Text>
                        <Badge size="xs" color={broadcast.deliveryStatus === 'delivered' ? 'green' : broadcast.deliveryStatus === 'failed' ? 'red' : 'blue'} variant="light">
                          {broadcast.deliveryStatus.replaceAll('_', ' ')}
                        </Badge>
                      </Group>
                      <Text size="sm" mt={4} lineClamp={2}>{broadcast.message}</Text>
                      {broadcast.recipientCount !== null ? <Text size="xs" c="dimmed">{broadcast.recipientCount} eligible recipients</Text> : null}
                    </Box>
                    <Stack gap={4} align="flex-end">
                      <Text size="xs" c="dimmed">
                        {formatDateTimeForDisplay(broadcast.timestampMs, 'unknown')}
                      </Text>
                      <Tooltip label="Open tour">
                        <ActionIcon variant="light" size="sm" onClick={() => openToursUrl(navigate, {
                    q: broadcast.tourId
                  })}>
                          <IconExternalLink size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Stack>
                  </Group>
                </Paper>)}
            </Stack> : <EmptyState icon={IconSpeakerphone} color="gray" title="No broadcasts loaded" description="No broadcast records are present in the loaded Firebase branch." />}
        </Card>
      </SimpleGrid>

      <Card shadow="sm" padding="md" radius="md" withBorder>
        <PanelHeader icon={IconCalendar} title="Realtime And Backend Sync Health" description="Health uses the shared LLT sync taxonomy and the actual listener state for each dashboard branch." right={<Badge variant="light" color={healthSnapshot.color}>
              {healthSnapshot.label}
            </Badge>} />

        <SimpleGrid cols={{
        base: 1,
        md: 3
      }} spacing="sm" mb="md">
          {syncSummaryCards.map(status => {
          const Icon = status.icon;
          return <Paper key={status.label} p="sm" radius="md" withBorder>
                <Group wrap="nowrap">
                  <ThemeIcon color={status.color} variant="light" size="md" radius="md">
                    <Icon size={15} />
                  </ThemeIcon>
                  <Box style={{
                flex: 1,
                minWidth: 0
              }}>
                    <Text size="sm" fw={600}>{status.label}</Text>
                    <Text size="xs" c="dimmed">{status.description}</Text>
                  </Box>
                  <Badge size="sm" color={status.color} variant="light">{status.value}</Badge>
                </Group>
              </Paper>;
        })}
        </SimpleGrid>

        <SimpleGrid cols={{
        base: 1,
        md: 2,
        xl: 3
      }} spacing="sm">
          {branchKeys.map(branchKey => <BranchHealthRow key={branchKey} branchKey={branchKey} loading={branchLoading[branchKey]} error={branchErrors[branchKey]} syncedAt={branchSyncedAt[branchKey]} />)}
        </SimpleGrid>

        <Divider my="md" />
        <Group gap="xs" wrap="wrap">
          <Badge color="gray" variant="outline">{HEALTH_STATE.OFFLINE_NO_NETWORK}</Badge>
          <Badge color="gray" variant="outline">{HEALTH_STATE.ONLINE_BACKEND_DEGRADED}</Badge>
          <Badge color="gray" variant="outline">{HEALTH_STATE.ONLINE_BACKLOG_PENDING}</Badge>
          <Badge color="gray" variant="outline">{HEALTH_STATE.ONLINE_HEALTHY}</Badge>
        </Group>
      </Card>
    </Stack>;
}
