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
import { Text, Title, Group, Button, Stack, Badge, ActionIcon, Tooltip, Modal, Paper, ThemeIcon, Avatar, SimpleGrid, Alert, Progress, Timeline, CopyButton, Code, Accordion } from '@mantine/core';
import { IconMap, IconPhone, IconUsers, IconMapPin, IconTrash, IconCopy, IconAlertCircle, IconCalendarEvent } from '@tabler/icons-react';
import { deleteTour } from '../../../services/tourService';
import { formatDateForDisplay } from '../../../utils/dateUtils';
// Tour Card Component for grid view
export function DeleteTourModal({
  opened,
  onClose,
  tourId,
  tourName,
  onConfirm
}) {
  const [loading, setLoading] = useState(false);
  const handleDelete = async () => {
    setLoading(true);
    try {
      await deleteTour(tourId);
      notifications.show({
        title: 'Tour Deleted',
        message: `"${tourName || tourId}" has been deleted`,
        color: 'green'
      });
      onConfirm();
      onClose();
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red'
      });
    } finally {
      setLoading(false);
    }
  };
  return <Modal opened={opened} onClose={onClose} title="Delete Tour" centered size="sm">
      <Stack gap="md">
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
          This action cannot be undone. The tour and all its data will be permanently deleted.
        </Alert>

        <Paper p="md" radius="md" bg="red.0">
          <Group gap="xs">
            <ThemeIcon color="red" variant="light" size="lg">
              <IconTrash size={18} />
            </ThemeIcon>
            <div>
              <Text fw={600}>{tourName || tourId}</Text>
              <Text size="xs" c="dimmed">ID: {tourId}</Text>
            </div>
          </Group>
        </Paper>

        <Group justify="flex-end" mt="md">
          <Button variant="light" onClick={onClose}>Cancel</Button>
          <Button color="red" loading={loading} onClick={handleDelete} leftSection={<IconTrash size={16} />}>
            Delete Tour
          </Button>
        </Group>
      </Stack>
    </Modal>;
}

// Tour Details Modal
export function TourDetailsModal({
  opened,
  onClose,
  tourId,
  tour
}) {
  if (!tour) return null;
  const isAssigned = tour.driverName && tour.driverName !== 'TBA';
  const pickupPoints = tour.pickupPoints || [];
  const itinerary = tour.itinerary || {
    title: '',
    days: []
  };
  const capacityPercent = (tour.currentParticipants || 0) / (tour.maxParticipants || 53) * 100;
  return <Modal opened={opened} onClose={onClose} title={<Group gap="xs">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconMap size={16} />
          </ThemeIcon>
          <Text fw={600}>Tour Details</Text>
        </Group>} size="lg" centered>
      <Stack gap="md">
        {/* Header Info */}
        <Paper p="md" radius="md" withBorder>
          <Group justify="space-between" mb="sm">
            <div>
              <Title order={3}>{tour.name || tourId}</Title>
              <Group gap="xs" mt={4}>
                <Code>{tour.tourCode || tourId}</Code>
                <CopyButton value={tourId}>
                  {({
                  copied,
                  copy
                }) => <Tooltip label={copied ? 'Copied!' : 'Copy ID'}>
                      <ActionIcon variant="subtle" size="xs" onClick={copy}>
                        <IconCopy size={12} />
                      </ActionIcon>
                    </Tooltip>}
                </CopyButton>
              </Group>
            </div>
            <Stack gap="xs" align="flex-end">
              <Badge variant="filled" color={tour.isActive ? 'green' : 'gray'}>
                {tour.isActive ? 'Active' : 'Inactive'}
              </Badge>
              <Badge variant="light" color="blue">
                {tour.days || 1} Day{(tour.days || 1) > 1 ? 's' : ''}
              </Badge>
            </Stack>
          </Group>
        </Paper>

        {/* Dates & Capacity */}
        <SimpleGrid cols={2} spacing="md">
          <Paper p="md" radius="md" withBorder>
            <Group gap="xs" mb="xs">
              <IconCalendarEvent size={16} color="gray" />
              <Text fw={500}>Dates</Text>
            </Group>
            <Text size="sm">Start: {formatDateForDisplay(tour.startDate)}</Text>
            <Text size="sm">End: {formatDateForDisplay(tour.endDate)}</Text>
          </Paper>
          <Paper p="md" radius="md" withBorder>
            <Group gap="xs" mb="xs">
              <IconUsers size={16} color="gray" />
              <Text fw={500}>Capacity</Text>
            </Group>
            <Text size="xl" fw={700}>{tour.currentParticipants || 0} / {tour.maxParticipants || 53}</Text>
            <Progress value={capacityPercent} color={capacityPercent > 90 ? 'red' : capacityPercent > 70 ? 'orange' : 'blue'} size="sm" mt="xs" />
          </Paper>
        </SimpleGrid>

        {/* Driver Info */}
        <Paper p="md" radius="md" withBorder>
          <Text fw={500} mb="sm">Assigned Driver</Text>
          <Group gap="md">
            <Avatar size="lg" radius="xl" color={isAssigned ? 'brand' : 'gray'}>
              {tour.driverName?.charAt(0) || '?'}
            </Avatar>
            <div style={{
            flex: 1
          }}>
              <Text fw={500}>{tour.driverName || 'TBA'}</Text>
              {tour.driverPhone && <Group gap="xs">
                  <IconPhone size={14} color="gray" />
                  <Text size="sm" c="dimmed">{tour.driverPhone}</Text>
                </Group>}
            </div>
            <Badge variant="dot" color={isAssigned ? 'green' : 'orange'}>
              {isAssigned ? 'Assigned' : 'Unassigned'}
            </Badge>
          </Group>
        </Paper>

        {/* Pickup Points */}
        {pickupPoints.length > 0 && <Paper p="md" radius="md" withBorder>
            <Text fw={500} mb="sm">Pickup Points ({pickupPoints.length})</Text>
            <Timeline active={-1} bulletSize={20}>
              {pickupPoints.map((pp, index) => <Timeline.Item key={index} bullet={<IconMapPin size={12} />} title={<Group gap="xs">
                      {pp.time && <Badge size="xs" variant="light">{pp.time}</Badge>}
                      <Text size="sm">{pp.location}</Text>
                    </Group>} />)}
            </Timeline>
          </Paper>}

        {/* Itinerary */}
        {itinerary.days && itinerary.days.length > 0 && <Paper p="md" radius="md" withBorder>
            <Text fw={500} mb="sm">Itinerary: {itinerary.title || tour.name}</Text>
            <Accordion variant="separated">
              {itinerary.days.map((day, dayIndex) => <Accordion.Item key={dayIndex} value={`day-${day.day || dayIndex + 1}`}>
                  <Accordion.Control>
                    <Group gap="xs">
                      <Badge size="sm" variant="light">Day {day.day || dayIndex + 1}</Badge>
                      <Text size="sm">{day.title || `Day ${day.day || dayIndex + 1} Activities`}</Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="xs">
                      {(day.activities || []).map((activity, actIndex) => <Group key={actIndex} gap="xs" align="flex-start">
                          {activity.time && <Badge size="xs" variant="light" style={{
                    minWidth: 50
                  }}>
                              {activity.time}
                            </Badge>}
                          <Text size="sm" style={{
                    flex: 1
                  }}>{activity.description}</Text>
                        </Group>)}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>)}
            </Accordion>
          </Paper>}

        <Button variant="light" onClick={onClose} fullWidth>
          Close
        </Button>
      </Stack>
    </Modal>;
}

// Import/Export Modal
