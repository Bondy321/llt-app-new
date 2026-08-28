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

import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import { Card, Text, Group, Button, Select, Stack, Badge, ActionIcon, Tooltip, Modal, Paper, ThemeIcon, Menu, Progress } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconMap, IconUser, IconEdit, IconDotsVertical, IconX, IconCalendar, IconUsers, IconMapPin, IconTrash, IconCopy, IconEye, IconUserPlus } from '@tabler/icons-react';
import { assignDriver, unassignDriver } from '../../../services/tourService';
import { formatDateRangeForDisplay, formatDateTimeForDisplay } from '../../../utils/dateUtils';
// Tour Card Component for grid view
const PACK_STATUS_COLOR = {
  ready: 'green',
  degraded: 'yellow',
  stale: 'orange',
  cancelled: 'red',
  withdrawn: 'red',
  expired: 'gray',
  missing: 'gray',
  ambiguous: 'orange'
};
export function TourPackStatus({
  coverage
}) {
  const pack = coverage?.pack || {
    state: 'missing'
  };
  const label = pack.state === 'ready' ? 'Pack ready' : pack.state === 'degraded' ? 'Pack degraded' : pack.state === 'missing' ? 'Pack unavailable' : `Pack ${pack.state}`;
  const assignment = coverage?.assignmentCoverage === 'covered' ? 'Assigned driver covered' : coverage?.assignmentCoverage === 'uncovered' ? 'Assigned driver has no usable pack' : coverage?.assignmentCoverage === 'inconsistent' ? 'Driver assignment links conflict' : coverage?.assignmentCoverage === 'legacy' ? 'Driver name is not a canonical assignment' : 'No driver assigned';
  return <Stack gap={3}>
      <Tooltip label={pack.reason || `Revision ${pack.revision || '—'} · last publication ${formatDateTimeForDisplay(pack.publishedAtMs, 'unknown')}`}>
        <Badge variant="light" color={PACK_STATUS_COLOR[pack.state] || 'gray'}>{label}</Badge>
      </Tooltip>
      <Text size="xs" c={['uncovered', 'inconsistent', 'legacy'].includes(coverage?.assignmentCoverage) ? 'red' : 'dimmed'}>{assignment}</Text>
      {pack.revision ? <Text size="xs" c="dimmed">Rev {pack.revision} · {formatDateTimeForDisplay(pack.publishedAtMs, 'unknown')}</Text> : null}
    </Stack>;
}
export function DriverPackOperations({
  operations,
  onIssueStatus,
  updatingIssueId
}) {
  if (!operations || operations.state === 'missing') return null;
  if (operations.state === 'ambiguous') return <Text size="xs" c="orange">Progress unavailable: {operations.reason}</Text>;
  const progress = operations.progress || [];
  const completedPickups = progress.reduce((total, item) => total + item.pickupCompleted, 0);
  const pickupTotal = progress.reduce((total, item) => total + item.pickupTotal, 0);
  const acknowledgementPending = progress.some(item => !item.acknowledgementCurrent);
  const openIssueCount = progress.reduce((total, item) => total + item.openIssueCount, 0);
  return <Stack gap={4} mt={4}>
    <Text size="xs" c={operations.state === 'stale' ? 'orange' : 'dimmed'}>
      {operations.state === 'stale' ? 'Driver progress is stale' : `Pickup progress ${completedPickups}/${pickupTotal || 0}`}
    </Text>
    {acknowledgementPending ? <Text size="xs" c="orange">Published revision awaiting driver acknowledgement</Text> : null}
    {openIssueCount ? <Text size="xs" c="red">{openIssueCount} open structured issue{openIssueCount === 1 ? '' : 's'}</Text> : null}
    {operations.issues.map(issue => <Group key={issue.issueId} gap="xs" wrap="nowrap">
      <Badge size="xs" color={issue.severity === 'critical' ? 'red' : issue.severity === 'warning' ? 'orange' : 'yellow'}>{issue.category}</Badge>
      <Text size="xs" style={{
        flex: 1
      }}>{issue.status.replace('_', ' ')}</Text>
      {issue.status === 'open' ? <Button size="compact-xs" variant="light" loading={updatingIssueId === issue.issueId} onClick={() => onIssueStatus(issue, 'acknowledged')}>Acknowledge</Button> : null}
      {issue.status !== 'resolved' ? <Button size="compact-xs" variant="subtle" loading={updatingIssueId === issue.issueId} onClick={() => onIssueStatus(issue, 'resolved')}>Resolve</Button> : null}
    </Group>)}
  </Stack>;
}
export function TourCard({
  tourId,
  tour,
  drivers,
  packCoverage,
  packOperations,
  onIssueStatus,
  updatingIssueId,
  onEdit,
  onDelete,
  onDuplicate,
  onViewDetails,
  onAddPassenger
}) {
  const [assignModalOpened, {
    open: openAssignModal,
    close: closeAssignModal
  }] = useDisclosure(false);
  const [selectedDriver, setSelectedDriver] = useState('');
  const [assignmentPending, setAssignmentPending] = useState(false);
  const [assignmentStatus, setAssignmentStatus] = useState('');
  const driverOptions = Object.entries(drivers).map(([id, driver]) => ({
    value: id,
    label: `${driver.name} (${id})`
  }));
  const handleAssign = async () => {
    if (!selectedDriver) return;
    const driver = drivers[selectedDriver];
    setAssignmentPending(true);
    setAssignmentStatus('Updating the driver assignment safely…');
    try {
      await assignDriver(tourId, selectedDriver, {
        name: driver.name,
        phone: driver.phone || '',
        authUid: driver.authUid || ''
      });
      notifications.show({
        title: 'Driver Assigned',
        message: `${driver.name} assigned to tour ${tourId}`,
        color: 'green'
      });
      closeAssignModal();
      setSelectedDriver('');
      setAssignmentStatus('Driver assignment completed.');
    } catch (error) {
      const continuing = error?.code === 'ASSIGNMENT_IN_PROGRESS';
      setAssignmentStatus(continuing
        ? `Assignment is continuing (${error?.continuation?.status || 'in progress'}). Retry to advance it.`
        : error.message);
      notifications.show({
        title: continuing ? 'Assignment in progress' : 'Assignment Failed',
        message: error.message,
        color: continuing ? 'yellow' : 'red'
      });
    } finally {
      setAssignmentPending(false);
    }
  };
  const handleUnassign = async () => {
    setAssignmentPending(true);
    setAssignmentStatus('Updating the driver assignment safely…');
    try {
      await unassignDriver(tourId);
      notifications.show({
        title: 'Driver Unassigned',
        message: `Tour ${tourId} is now unassigned`,
        color: 'blue'
      });
      setAssignmentStatus('Driver unassignment completed.');
    } catch (error) {
      const continuing = error?.code === 'ASSIGNMENT_IN_PROGRESS';
      setAssignmentStatus(continuing
        ? `Unassignment is continuing (${error?.continuation?.status || 'in progress'}). Retry to advance it.`
        : error.message);
      notifications.show({
        title: continuing ? 'Unassignment in progress' : 'Error',
        message: error.message,
        color: continuing ? 'yellow' : 'red'
      });
    } finally {
      setAssignmentPending(false);
    }
  };
  const isAssigned = tour.driverName && tour.driverName !== 'TBA';
  const capacityPercent = (tour.currentParticipants || 0) / (tour.maxParticipants || 53) * 100;
  return <>
      <Card shadow="sm" padding="lg" radius="md" withBorder className="interactive-card">
        <Group justify="space-between" mb="xs">
          <Group gap="xs">
            <Badge variant="light" color={tour.isActive ? 'green' : 'gray'}>
              {tour.isActive ? 'Active' : 'Inactive'}
            </Badge>
            <Badge variant="light" color="blue">
              {tour.days || 1} Day{(tour.days || 1) > 1 ? 's' : ''}
            </Badge>
          </Group>
          <Menu shadow="md" width={200}>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray">
                <IconDotsVertical size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Tour Actions</Menu.Label>
              <Menu.Item leftSection={<IconEye size={14} />} onClick={() => onViewDetails(tourId)}>
                View Details
              </Menu.Item>
              <Menu.Item leftSection={<IconEdit size={14} />} onClick={() => onEdit(tourId)}>
                Edit Tour
              </Menu.Item>
              <Menu.Item leftSection={<IconUserPlus size={14} />} onClick={() => onAddPassenger(tourId)}>
                Add Passenger
              </Menu.Item>
              <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => onDuplicate(tourId)}>
                Duplicate
              </Menu.Item>
              <Menu.Divider />
              <Menu.Label>Driver</Menu.Label>
              <Menu.Item leftSection={<IconUser size={14} />} onClick={openAssignModal}>
                {isAssigned ? 'Reassign Driver' : 'Assign Driver'}
              </Menu.Item>
              {isAssigned && <Menu.Item leftSection={<IconX size={14} />} color="orange" onClick={handleUnassign}>
                  Unassign Driver
                </Menu.Item>}
              <Menu.Divider />
              <Menu.Item leftSection={<IconTrash size={14} />} color="red" onClick={() => onDelete(tourId)}>
                Delete Tour
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>

        <Group gap="xs" mb="sm">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconMap size={16} />
          </ThemeIcon>
          <div style={{
          flex: 1,
          minWidth: 0
        }}>
            <Text fw={600} size="lg" truncate="end">
              {tour.name || tourId}
            </Text>
            <Text size="xs" c="dimmed" truncate="end">{tour.tourCode || tourId}</Text>
          </div>
        </Group>

        <Stack gap="xs" mb="md">
          <Group gap="xs">
            <IconCalendar size={14} color="gray" />
            <Text size="sm" c="dimmed">
              {formatDateRangeForDisplay(tour.startDate, tour.endDate)}
            </Text>
          </Group>
          <Group gap="xs">
            <IconUser size={14} color="gray" />
            <Text size="sm" c={isAssigned ? 'dark' : 'dimmed'}>
              {tour.driverName || 'TBA'}
            </Text>
            {isAssigned && <Badge size="xs" color="green">Assigned</Badge>}
          </Group>
          <Group gap="xs">
            <IconUsers size={14} color="gray" />
            <Text size="sm" c="dimmed">
              {tour.currentParticipants || 0} / {tour.maxParticipants || 53} participants
            </Text>
          </Group>
          <Progress value={capacityPercent} color={capacityPercent > 90 ? 'red' : capacityPercent > 70 ? 'orange' : 'blue'} size="sm" />
          {tour.pickupPoints && tour.pickupPoints.length > 0 && <Group gap="xs">
              <IconMapPin size={14} color="gray" />
              <Text size="sm" c="dimmed" truncate="end">
                {tour.pickupPoints.length} pickup point{tour.pickupPoints.length > 1 ? 's' : ''}
              </Text>
            </Group>}
          <TourPackStatus coverage={packCoverage} />
          <DriverPackOperations operations={packOperations} onIssueStatus={onIssueStatus} updatingIssueId={updatingIssueId} />
        </Stack>

        <Group grow>
          <Button variant="light" size="sm" onClick={() => onViewDetails(tourId)}>
            View Details
          </Button>
          <Button variant={isAssigned ? 'light' : 'filled'} size="sm" onClick={openAssignModal}>
            {isAssigned ? 'Reassign' : 'Assign'}
          </Button>
        </Group>
      </Card>

      {/* Assignment Modal */}
      <Modal opened={assignModalOpened} onClose={closeAssignModal} title="Assign Driver to Tour" centered>
        <Stack gap="md">
          <Paper p="md" radius="md" bg="gray.0">
            <Group gap="xs">
              <ThemeIcon color="brand" variant="light" size="lg">
                <IconMap size={18} />
              </ThemeIcon>
              <div>
                <Text fw={600}>{tour.name || tourId}</Text>
                <Text size="xs" c="dimmed">
                  Current: {tour.driverName || 'TBA'}
                </Text>
              </div>
            </Group>
          </Paper>

          <Select label="Select Driver" placeholder="Choose a driver" data={driverOptions} value={selectedDriver} onChange={setSelectedDriver} searchable clearable leftSection={<IconUsers size={16} />} />

          {assignmentStatus && <Text role="status" aria-live="polite" size="sm" c="dimmed">
              {assignmentStatus}
            </Text>}

          <Group justify="flex-end" mt="md">
            <Button variant="light" onClick={closeAssignModal} disabled={assignmentPending}>Cancel</Button>
            <Button onClick={handleAssign} disabled={!selectedDriver} loading={assignmentPending}>
              Assign Driver
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>;
}

// Create Tour Modal Component
