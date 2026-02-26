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

import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ref, onValue } from 'firebase/database';
import { db } from '../firebase';
import { notifications } from '@mantine/notifications';
import {
  Card,
  Text,
  Title,
  Group,
  Button,
  TextInput,
  Select,
  Stack,
  Box,
  Badge,
  Table,
  ScrollArea,
  ActionIcon,
  Tooltip,
  Modal,
  Loader,
  Center,
  Paper,
  ThemeIcon,
  Menu,
  Divider,
  Avatar,
  SimpleGrid,
  Pagination,
  SegmentedControl,
  Textarea,
  NumberInput,
  Grid,
  Tabs,
  Alert,
  FileButton,
  Progress,
  Timeline,
  Collapse,
  CopyButton,
  Code,
  Indicator,
  Switch,
  Accordion,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconSearch,
  IconFilter,
  IconRefresh,
  IconMap,
  IconUser,
  IconPhone,
  IconEdit,
  IconDotsVertical,
  IconCheck,
  IconX,
  IconCalendar,
  IconBus,
  IconUsers,
  IconMapPin,
  IconPlus,
  IconTrash,
  IconCopy,
  IconDownload,
  IconUpload,
  IconTemplate,
  IconClock,
  IconRoute,
  IconEye,
  IconAlertCircle,
  IconCircleCheck,
  IconPlayerPlay,
  IconInfoCircle,
  IconNotes,
  IconDatabaseExport,
  IconChevronDown,
  IconChevronRight,
  IconCalendarEvent,
  IconListDetails,
} from '@tabler/icons-react';
import {
  DEFAULT_TOUR,
  TOUR_TEMPLATES,
  createTour,
  createTourFromTemplate,
  updateTour,
  deleteTour,
  assignDriver,
  unassignDriver,
  duplicateTour,
  exportToursToCSV,
  previewTourCSVImport,
  executeTourCSVImport,
  ddmmyyyyToInputFormat,
  inputFormatToDDMMYYYY,
} from '../services/tourService';
import {
  parseISODateStrict,
  formatDateForDisplay,
  formatDateRangeForDisplay,
} from '../utils/dateUtils';

const getIsoDateFieldError = (value, fieldLabel) => {
  const parsed = parseISODateStrict(value);
  if (parsed.success) return null;
  return `${fieldLabel} must be a valid date (yyyy-MM-dd).`;
};

// Tour Card Component for grid view
function TourCard({ tourId, tour, drivers, onEdit, onDelete, onDuplicate, onViewDetails }) {
  const [assignModalOpened, { open: openAssignModal, close: closeAssignModal }] = useDisclosure(false);
  const [selectedDriver, setSelectedDriver] = useState('');

  const driverOptions = Object.entries(drivers).map(([id, driver]) => ({
    value: id,
    label: `${driver.name} (${id})`,
  }));

  const handleAssign = async () => {
    if (!selectedDriver) return;

    const driver = drivers[selectedDriver];
    try {
      await assignDriver(tourId, selectedDriver, {
        name: driver.name,
        phone: driver.phone || '',
      });
      notifications.show({
        title: 'Driver Assigned',
        message: `${driver.name} assigned to tour ${tourId}`,
        color: 'green',
      });
      closeAssignModal();
      setSelectedDriver('');
    } catch (error) {
      notifications.show({
        title: 'Assignment Failed',
        message: error.message,
        color: 'red',
      });
    }
  };

  const handleUnassign = async () => {
    try {
      await unassignDriver(tourId);
      notifications.show({
        title: 'Driver Unassigned',
        message: `Tour ${tourId} is now unassigned`,
        color: 'blue',
      });
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    }
  };

  const isAssigned = tour.driverName && tour.driverName !== 'TBA';
  const capacityPercent = ((tour.currentParticipants || 0) / (tour.maxParticipants || 53)) * 100;

  return (
    <>
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
              <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => onDuplicate(tourId)}>
                Duplicate
              </Menu.Item>
              <Menu.Divider />
              <Menu.Label>Driver</Menu.Label>
              <Menu.Item leftSection={<IconUser size={14} />} onClick={openAssignModal}>
                {isAssigned ? 'Reassign Driver' : 'Assign Driver'}
              </Menu.Item>
              {isAssigned && (
                <Menu.Item
                  leftSection={<IconX size={14} />}
                  color="orange"
                  onClick={handleUnassign}
                >
                  Unassign Driver
                </Menu.Item>
              )}
              <Menu.Divider />
              <Menu.Item
                leftSection={<IconTrash size={14} />}
                color="red"
                onClick={() => onDelete(tourId)}
              >
                Delete Tour
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>

        <Group gap="xs" mb="sm">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconMap size={16} />
          </ThemeIcon>
          <div style={{ flex: 1, minWidth: 0 }}>
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
          {tour.pickupPoints && tour.pickupPoints.length > 0 && (
            <Group gap="xs">
              <IconMapPin size={14} color="gray" />
              <Text size="sm" c="dimmed" truncate="end">
                {tour.pickupPoints.length} pickup point{tour.pickupPoints.length > 1 ? 's' : ''}
              </Text>
            </Group>
          )}
        </Stack>

        <Group grow>
          <Button variant="light" size="sm" onClick={() => onViewDetails(tourId)}>
            View Details
          </Button>
          <Button
            variant={isAssigned ? 'light' : 'filled'}
            size="sm"
            onClick={openAssignModal}
          >
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

          <Select
            label="Select Driver"
            placeholder="Choose a driver"
            data={driverOptions}
            value={selectedDriver}
            onChange={setSelectedDriver}
            searchable
            clearable
            leftSection={<IconUsers size={16} />}
          />

          <Group justify="flex-end" mt="md">
            <Button variant="light" onClick={closeAssignModal}>Cancel</Button>
            <Button onClick={handleAssign} disabled={!selectedDriver}>
              Assign Driver
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

// Create Tour Modal Component
function CreateTourModal({ opened, onClose, onSuccess, userEmail }) {
  const [activeTab, setActiveTab] = useState('manual');
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ ...DEFAULT_TOUR });
  const [pickupPointsText, setPickupPointsText] = useState('');

  const resetForm = () => {
    setFormData({ ...DEFAULT_TOUR });
    setPickupPointsText('');
    setActiveTab('manual');
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleCreateManual = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please enter a tour name',
        color: 'red',
      });
      return;
    }

    if (!formData.tourCode.trim()) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please enter a tour code',
        color: 'red',
      });
      return;
    }

    const startDateError = getIsoDateFieldError(formData.startDate, 'Start date');
    const endDateError = getIsoDateFieldError(formData.endDate, 'End date');
    if (startDateError || endDateError) {
      notifications.show({
        title: 'Invalid Date',
        message: startDateError || endDateError,
        color: 'red',
      });
      return;
    }

    setLoading(true);
    try {
      // Parse pickup points from text
      const pickupPoints = pickupPointsText
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const match = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)$/);
          if (match) {
            return { time: match[1], location: match[2].trim() };
          }
          return { time: '', location: line.trim() };
        });

      const tourData = {
        ...formData,
        startDate: inputFormatToDDMMYYYY(formData.startDate),
        endDate: inputFormatToDDMMYYYY(formData.endDate),
        pickupPoints,
        itinerary: {
          title: formData.name,
          days: []
        }
      };

      const result = await createTour(tourData, userEmail);
      notifications.show({
        title: 'Tour Created',
        message: `"${formData.name}" has been created successfully`,
        color: 'green',
      });
      onSuccess(result.id);
      handleClose();
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFromTemplate = async (templateKey) => {
    setLoading(true);
    try {
      const result = await createTourFromTemplate(templateKey, {}, userEmail);
      notifications.show({
        title: 'Tour Created',
        message: `Tour created from "${TOUR_TEMPLATES[templateKey].name}" template`,
        color: 'green',
      });
      onSuccess(result.id);
      handleClose();
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={
        <Group gap="xs">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconPlus size={16} />
          </ThemeIcon>
          <Text fw={600}>Create New Tour</Text>
        </Group>
      }
      size="lg"
      centered
    >
      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="manual" leftSection={<IconEdit size={14} />}>
            Manual Entry
          </Tabs.Tab>
          <Tabs.Tab value="templates" leftSection={<IconTemplate size={14} />}>
            From Template
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="manual">
          <form onSubmit={handleCreateManual}>
            <Stack gap="md">
              <Grid>
                <Grid.Col span={8}>
                  <TextInput
                    label="Tour Name"
                    placeholder="e.g., Coronation Street Experience"
                    value={formData.name}
                    onChange={(e) => handleInputChange('name', e.target.value)}
                    leftSection={<IconMap size={16} />}
                    required
                  />
                </Grid.Col>
                <Grid.Col span={4}>
                  <TextInput
                    label="Tour Code"
                    placeholder="e.g., 5209L 16"
                    value={formData.tourCode}
                    onChange={(e) => handleInputChange('tourCode', e.target.value)}
                    required
                  />
                </Grid.Col>
              </Grid>

              <Grid>
                <Grid.Col span={4}>
                  <NumberInput
                    label="Days"
                    value={formData.days}
                    onChange={(val) => handleInputChange('days', val)}
                    min={1}
                    max={30}
                  />
                </Grid.Col>
                <Grid.Col span={4}>
                  <TextInput
                    label="Start Date"
                    type="date"
                    value={ddmmyyyyToInputFormat(formData.startDate)}
                    onChange={(e) => handleInputChange('startDate', e.target.value)}
                    leftSection={<IconCalendar size={16} />}
                    error={getIsoDateFieldError(ddmmyyyyToInputFormat(formData.startDate), 'Start date')}
                    required
                  />
                </Grid.Col>
                <Grid.Col span={4}>
                  <TextInput
                    label="End Date"
                    type="date"
                    value={ddmmyyyyToInputFormat(formData.endDate)}
                    onChange={(e) => handleInputChange('endDate', e.target.value)}
                    leftSection={<IconCalendar size={16} />}
                    error={getIsoDateFieldError(ddmmyyyyToInputFormat(formData.endDate), 'End date')}
                    required
                  />
                </Grid.Col>
              </Grid>

              <Grid>
                <Grid.Col span={6}>
                  <NumberInput
                    label="Max Participants"
                    value={formData.maxParticipants}
                    onChange={(val) => handleInputChange('maxParticipants', val)}
                    min={1}
                    max={100}
                    leftSection={<IconUsers size={16} />}
                  />
                </Grid.Col>
                <Grid.Col span={6}>
                  <NumberInput
                    label="Current Participants"
                    value={formData.currentParticipants}
                    onChange={(val) => handleInputChange('currentParticipants', val)}
                    min={0}
                    max={formData.maxParticipants}
                  />
                </Grid.Col>
              </Grid>

              <Switch
                label="Tour is Active"
                checked={formData.isActive}
                onChange={(e) => handleInputChange('isActive', e.currentTarget.checked)}
              />

              <Textarea
                label="Pickup Points"
                placeholder="Enter one per line in format: HH:MM - Location&#10;e.g., 06:30 - Dundee - Seagate Bus Station"
                value={pickupPointsText}
                onChange={(e) => setPickupPointsText(e.target.value)}
                minRows={4}
                description="Format: TIME - LOCATION (one per line)"
              />

              <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
                The tour will be created with driver set to "TBA". You can assign a driver after creation.
                Itinerary details can be edited after the tour is created.
              </Alert>

              <Group justify="flex-end" mt="md">
                <Button variant="light" onClick={handleClose}>Cancel</Button>
                <Button type="submit" loading={loading} leftSection={<IconPlus size={16} />}>
                  Create Tour
                </Button>
              </Group>
            </Stack>
          </form>
        </Tabs.Panel>

        <Tabs.Panel value="templates">
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Select a pre-configured tour template to quickly create a new tour.
              You can edit the details after creation.
            </Text>

            <SimpleGrid cols={1} spacing="md">
              {Object.entries(TOUR_TEMPLATES).map(([key, template]) => (
                <Paper
                  key={key}
                  p="md"
                  radius="md"
                  withBorder
                  style={{ cursor: 'pointer' }}
                  onClick={() => handleCreateFromTemplate(key)}
                >
                  <Group justify="space-between">
                    <Group gap="md">
                      <ThemeIcon color="brand" variant="light" size="xl" radius="md">
                        <IconMap size={24} />
                      </ThemeIcon>
                      <div>
                        <Text fw={600}>{template.name}</Text>
                        <Group gap="xs" mt={4}>
                          <Badge size="xs" variant="light">
                            {template.days} Day{template.days > 1 ? 's' : ''}
                          </Badge>
                          <Badge size="xs" variant="light" color="blue">
                            {template.maxParticipants} max
                          </Badge>
                          <Badge size="xs" variant="light" color="green">
                            {template.pickupPoints?.length || 0} pickups
                          </Badge>
                        </Group>
                      </div>
                    </Group>
                    <ActionIcon variant="light" size="lg" color="brand">
                      <IconChevronRight size={18} />
                    </ActionIcon>
                  </Group>
                </Paper>
              ))}
            </SimpleGrid>

            {loading && (
              <Center py="md">
                <Loader size="sm" />
              </Center>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

// Edit Tour Modal Component
function EditTourModal({ opened, onClose, tourId, tour, onSuccess }) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ ...DEFAULT_TOUR });
  const [pickupPointsText, setPickupPointsText] = useState('');

  useEffect(() => {
    if (tour) {
      setFormData({ ...DEFAULT_TOUR, ...tour });
      // Convert pickup points to text format
      const ppText = (tour.pickupPoints || [])
        .map(pp => `${pp.time} - ${pp.location}`)
        .join('\n');
      setPickupPointsText(ppText);
    }
  }, [tour]);

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please enter a tour name',
        color: 'red',
      });
      return;
    }

    const startDateIso = formData.startDate?.includes('-') ? formData.startDate : ddmmyyyyToInputFormat(formData.startDate);
    const endDateIso = formData.endDate?.includes('-') ? formData.endDate : ddmmyyyyToInputFormat(formData.endDate);

    const startDateError = getIsoDateFieldError(startDateIso, 'Start date');
    const endDateError = getIsoDateFieldError(endDateIso, 'End date');
    if (startDateError || endDateError) {
      notifications.show({
        title: 'Invalid Date',
        message: startDateError || endDateError,
        color: 'red',
      });
      return;
    }

    setLoading(true);
    try {
      // Parse pickup points from text
      const pickupPoints = pickupPointsText
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const match = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)$/);
          if (match) {
            return { time: match[1], location: match[2].trim() };
          }
          return { time: '', location: line.trim() };
        });

      const updateData = {
        name: formData.name,
        tourCode: formData.tourCode,
        days: formData.days,
        startDate: inputFormatToDDMMYYYY(startDateIso),
        endDate: inputFormatToDDMMYYYY(endDateIso),
        isActive: formData.isActive,
        maxParticipants: formData.maxParticipants,
        currentParticipants: formData.currentParticipants,
        pickupPoints,
      };

      await updateTour(tourId, updateData);
      notifications.show({
        title: 'Tour Updated',
        message: `"${formData.name}" has been updated`,
        color: 'green',
      });
      onSuccess();
      onClose();
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ThemeIcon color="blue" variant="light" size="md">
            <IconEdit size={16} />
          </ThemeIcon>
          <Text fw={600}>Edit Tour</Text>
        </Group>
      }
      size="lg"
      centered
    >
      <form onSubmit={handleSave}>
        <Stack gap="md">
          <Paper p="sm" radius="md" bg="gray.0">
            <Group gap="xs">
              <Text size="xs" c="dimmed">Tour ID:</Text>
              <Code>{tourId}</Code>
              <CopyButton value={tourId}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? 'Copied!' : 'Copy ID'}>
                    <ActionIcon variant="subtle" size="xs" onClick={copy}>
                      <IconCopy size={12} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
          </Paper>

          <Grid>
            <Grid.Col span={8}>
              <TextInput
                label="Tour Name"
                placeholder="e.g., Coronation Street Experience"
                value={formData.name}
                onChange={(e) => handleInputChange('name', e.target.value)}
                leftSection={<IconMap size={16} />}
                required
              />
            </Grid.Col>
            <Grid.Col span={4}>
              <TextInput
                label="Tour Code"
                placeholder="e.g., 5209L 16"
                value={formData.tourCode}
                onChange={(e) => handleInputChange('tourCode', e.target.value)}
              />
            </Grid.Col>
          </Grid>

          <Grid>
            <Grid.Col span={4}>
              <NumberInput
                label="Days"
                value={formData.days}
                onChange={(val) => handleInputChange('days', val)}
                min={1}
                max={30}
              />
            </Grid.Col>
            <Grid.Col span={4}>
              <TextInput
                label="Start Date"
                type="date"
                value={ddmmyyyyToInputFormat(formData.startDate)}
                onChange={(e) => handleInputChange('startDate', e.target.value)}
                leftSection={<IconCalendar size={16} />}
                error={getIsoDateFieldError(ddmmyyyyToInputFormat(formData.startDate), 'Start date')}
                required
              />
            </Grid.Col>
            <Grid.Col span={4}>
              <TextInput
                label="End Date"
                type="date"
                value={ddmmyyyyToInputFormat(formData.endDate)}
                onChange={(e) => handleInputChange('endDate', e.target.value)}
                leftSection={<IconCalendar size={16} />}
                error={getIsoDateFieldError(ddmmyyyyToInputFormat(formData.endDate), 'End date')}
                required
              />
            </Grid.Col>
          </Grid>

          <Grid>
            <Grid.Col span={6}>
              <NumberInput
                label="Max Participants"
                value={formData.maxParticipants}
                onChange={(val) => handleInputChange('maxParticipants', val)}
                min={1}
                max={100}
                leftSection={<IconUsers size={16} />}
              />
            </Grid.Col>
            <Grid.Col span={6}>
              <NumberInput
                label="Current Participants"
                value={formData.currentParticipants}
                onChange={(val) => handleInputChange('currentParticipants', val)}
                min={0}
                max={formData.maxParticipants}
              />
            </Grid.Col>
          </Grid>

          <Switch
            label="Tour is Active"
            checked={formData.isActive}
            onChange={(e) => handleInputChange('isActive', e.currentTarget.checked)}
          />

          <Textarea
            label="Pickup Points"
            placeholder="Enter one per line in format: HH:MM - Location"
            value={pickupPointsText}
            onChange={(e) => setPickupPointsText(e.target.value)}
            minRows={4}
            description="Format: TIME - LOCATION (one per line)"
          />

          <Group justify="flex-end" mt="md">
            <Button variant="light" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading} leftSection={<IconCheck size={16} />}>
              Save Changes
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// Delete Confirmation Modal
function DeleteTourModal({ opened, onClose, tourId, tourName, onConfirm }) {
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    setLoading(true);
    try {
      await deleteTour(tourId);
      notifications.show({
        title: 'Tour Deleted',
        message: `"${tourName || tourId}" has been deleted`,
        color: 'green',
      });
      onConfirm();
      onClose();
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Delete Tour" centered size="sm">
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
    </Modal>
  );
}

// Tour Details Modal
function TourDetailsModal({ opened, onClose, tourId, tour, drivers }) {
  if (!tour) return null;

  const isAssigned = tour.driverName && tour.driverName !== 'TBA';
  const pickupPoints = tour.pickupPoints || [];
  const itinerary = tour.itinerary || { title: '', days: [] };
  const capacityPercent = ((tour.currentParticipants || 0) / (tour.maxParticipants || 53)) * 100;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconMap size={16} />
          </ThemeIcon>
          <Text fw={600}>Tour Details</Text>
        </Group>
      }
      size="lg"
      centered
    >
      <Stack gap="md">
        {/* Header Info */}
        <Paper p="md" radius="md" withBorder>
          <Group justify="space-between" mb="sm">
            <div>
              <Title order={3}>{tour.name || tourId}</Title>
              <Group gap="xs" mt={4}>
                <Code>{tour.tourCode || tourId}</Code>
                <CopyButton value={tourId}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied!' : 'Copy ID'}>
                      <ActionIcon variant="subtle" size="xs" onClick={copy}>
                        <IconCopy size={12} />
                      </ActionIcon>
                    </Tooltip>
                  )}
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
            <div style={{ flex: 1 }}>
              <Text fw={500}>{tour.driverName || 'TBA'}</Text>
              {tour.driverPhone && (
                <Group gap="xs">
                  <IconPhone size={14} color="gray" />
                  <Text size="sm" c="dimmed">{tour.driverPhone}</Text>
                </Group>
              )}
            </div>
            <Badge variant="dot" color={isAssigned ? 'green' : 'orange'}>
              {isAssigned ? 'Assigned' : 'Unassigned'}
            </Badge>
          </Group>
        </Paper>

        {/* Pickup Points */}
        {pickupPoints.length > 0 && (
          <Paper p="md" radius="md" withBorder>
            <Text fw={500} mb="sm">Pickup Points ({pickupPoints.length})</Text>
            <Timeline active={-1} bulletSize={20}>
              {pickupPoints.map((pp, index) => (
                <Timeline.Item
                  key={index}
                  bullet={<IconMapPin size={12} />}
                  title={
                    <Group gap="xs">
                      {pp.time && <Badge size="xs" variant="light">{pp.time}</Badge>}
                      <Text size="sm">{pp.location}</Text>
                    </Group>
                  }
                />
              ))}
            </Timeline>
          </Paper>
        )}

        {/* Itinerary */}
        {itinerary.days && itinerary.days.length > 0 && (
          <Paper p="md" radius="md" withBorder>
            <Text fw={500} mb="sm">Itinerary: {itinerary.title || tour.name}</Text>
            <Accordion variant="separated">
              {itinerary.days.map((day, dayIndex) => (
                <Accordion.Item key={dayIndex} value={`day-${day.day || dayIndex + 1}`}>
                  <Accordion.Control>
                    <Group gap="xs">
                      <Badge size="sm" variant="light">Day {day.day || dayIndex + 1}</Badge>
                      <Text size="sm">{day.title || `Day ${day.day || dayIndex + 1} Activities`}</Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="xs">
                      {(day.activities || []).map((activity, actIndex) => (
                        <Group key={actIndex} gap="xs" align="flex-start">
                          {activity.time && (
                            <Badge size="xs" variant="light" style={{ minWidth: 50 }}>
                              {activity.time}
                            </Badge>
                          )}
                          <Text size="sm" style={{ flex: 1 }}>{activity.description}</Text>
                        </Group>
                      ))}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          </Paper>
        )}

        <Button variant="light" onClick={onClose} fullWidth>
          Close
        </Button>
      </Stack>
    </Modal>
  );
}

// Import/Export Modal
function ImportExportModal({ opened, onClose, tours, onImportSuccess }) {
  const [activeTab, setActiveTab] = useState('export');
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState('upsert');
  const [importValidOnly, setImportValidOnly] = useState(true);
  const [importPreview, setImportPreview] = useState({ rows: [], parseErrors: [], summary: { total: 0, valid: 0, invalid: 0 } });
  const [rawCsvContent, setRawCsvContent] = useState('');

  const handleExport = () => {
    const csv = exportToursToCSV(tours);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `tours_export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    notifications.show({
      title: 'Export Complete',
      message: `${Object.keys(tours).length} tours exported to CSV`,
      color: 'green',
    });
  };

  const handleFileSelect = (file) => {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = String(e.target?.result || '');
        setRawCsvContent(content);
        const preview = await previewTourCSVImport(content, { mode: importMode });
        setImportPreview(preview);
      } catch (error) {
        notifications.show({
          title: 'Parse Error',
          message: error.message || 'Could not parse the CSV file. Please check the format.',
          color: 'red',
        });
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (importPreview.summary.total === 0) {
      notifications.show({
        title: 'No Data',
        message: 'Please select a CSV file with tour data',
        color: 'red',
      });
      return;
    }

    if (importValidOnly && importPreview.summary.valid === 0) {
      notifications.show({
        title: 'No Valid Rows',
        message: 'No valid rows available to import.',
        color: 'red',
      });
      return;
    }

    setImporting(true);
    try {
      const result = await executeTourCSVImport(importPreview.rows, {
        mode: importMode,
        importValidOnly,
        createdBy: 'import',
      });

      notifications.show({
        title: 'Import Complete',
        message: `Created ${result.created.length}, updated ${result.updated.length}, failed ${result.errors.length}`,
        color: result.errors.length > 0 ? 'orange' : 'green',
      });

      onImportSuccess();
      setImportPreview({ rows: [], parseErrors: [], summary: { total: 0, valid: 0, invalid: 0 } });
      setRawCsvContent('');
      onClose();
    } catch (error) {
      notifications.show({
        title: 'Import Error',
        message: error.message,
        color: 'red',
      });
    } finally {
      setImporting(false);
    }
  };

  const handleModeChange = async (mode) => {
    setImportMode(mode);
    if (!rawCsvContent) return;
    const preview = await previewTourCSVImport(rawCsvContent, { mode });
    setImportPreview(preview);
  };

  const rowsToShow = importPreview.rows.slice(0, 25);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconDatabaseExport size={16} />
          </ThemeIcon>
          <Text fw={600}>Import / Export Tours</Text>
        </Group>
      }
      size="xl"
      centered
    >
      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="export" leftSection={<IconDownload size={14} />}>
            Export
          </Tabs.Tab>
          <Tabs.Tab value="import" leftSection={<IconUpload size={14} />}>
            Import
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="export">
          <Stack gap="md">
            <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
              Export all tours to a CSV file for backup or external editing.
            </Alert>

            <Paper p="md" radius="md" withBorder>
              <Group justify="space-between">
                <div>
                  <Text fw={500}>Ready to Export</Text>
                  <Text size="sm" c="dimmed">{Object.keys(tours).length} tours will be exported</Text>
                </div>
                <ThemeIcon color="green" variant="light" size="xl" radius="md">
                  <IconCircleCheck size={24} />
                </ThemeIcon>
              </Group>
            </Paper>

            <Button leftSection={<IconDownload size={16} />} onClick={handleExport} fullWidth>
              Download CSV File
            </Button>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="import">
          <Stack gap="md">
            <Alert icon={<IconInfoCircle size={16} />} color="orange" variant="light">
              Import tours from CSV with validation preview. Required columns: Tour Code and Name.
            </Alert>

            <Select
              label="Import mode"
              value={importMode}
              onChange={(value) => value && handleModeChange(value)}
              data={[
                { value: 'create-only', label: 'Create only (reject existing tour codes)' },
                { value: 'update-existing', label: 'Update existing only (reject new tour codes)' },
                { value: 'upsert', label: 'Upsert (create new and update existing)' },
              ]}
            />

            <FileButton onChange={handleFileSelect} accept=".csv">
              {(props) => (
                <Paper
                  {...props}
                  p="xl"
                  radius="md"
                  withBorder
                  style={{ cursor: 'pointer', textAlign: 'center' }}
                >
                  <ThemeIcon color="brand" variant="light" size="xl" radius="xl" mx="auto" mb="sm">
                    <IconUpload size={24} />
                  </ThemeIcon>
                  <Text fw={500}>Click to select CSV file</Text>
                  <Text size="xs" c="dimmed">Supports quoted multiline and escaped quote fields</Text>
                </Paper>
              )}
            </FileButton>

            {(importPreview.parseErrors.length > 0 || importPreview.summary.total > 0) && (
              <Paper p="md" radius="md" withBorder>
                <Group justify="space-between" mb="sm">
                  <Text fw={500}>Dry-run Preview</Text>
                  <Group gap="xs">
                    <Badge color="blue">{importPreview.summary.total} rows</Badge>
                    <Badge color="green">{importPreview.summary.valid} valid</Badge>
                    <Badge color="red">{importPreview.summary.invalid} invalid</Badge>
                  </Group>
                </Group>

                {importPreview.parseErrors.map((error, index) => (
                  <Alert key={index} color="red" variant="light" mb="xs" icon={<IconAlertCircle size={16} />}>
                    {error}
                  </Alert>
                ))}

                <ScrollArea h={260}>
                  <Table striped highlightOnHover size="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Row</Table.Th>
                        <Table.Th>Mode</Table.Th>
                        <Table.Th>Tour Code</Table.Th>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Status</Table.Th>
                        <Table.Th>Errors</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {rowsToShow.map((row) => (
                        <Table.Tr key={row.rowNumber}>
                          <Table.Td>{row.rowNumber}</Table.Td>
                          <Table.Td><Badge size="xs" variant="light">{row.action}</Badge></Table.Td>
                          <Table.Td><Code>{row.tour.tourCode || '-'}</Code></Table.Td>
                          <Table.Td>{row.tour.name || '-'}</Table.Td>
                          <Table.Td>
                            <Badge color={row.isValid ? 'green' : 'red'} size="xs">{row.isValid ? 'Valid' : 'Invalid'}</Badge>
                          </Table.Td>
                          <Table.Td>
                            {row.errors.length === 0 ? '-' : row.errors.join(' ')}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
                {importPreview.rows.length > rowsToShow.length && (
                  <Text size="xs" c="dimmed" mt="xs">Showing first {rowsToShow.length} of {importPreview.rows.length} rows.</Text>
                )}
              </Paper>
            )}

            <Switch
              checked={importValidOnly}
              onChange={(event) => setImportValidOnly(event.currentTarget.checked)}
              label="Import valid rows only"
              description="When enabled, invalid rows are skipped."
            />

            <Button
              leftSection={<IconUpload size={16} />}
              onClick={handleImport}
              loading={importing}
              fullWidth
              disabled={importPreview.summary.total === 0}
            >
              Run Import
            </Button>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

// Main Tours Manager Component
export default function ToursManager() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tours, setTours] = useState({});
  const [drivers, setDrivers] = useState({});
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [viewMode, setViewMode] = useState('grid');
  const [currentPage, setCurrentPage] = useState(1);
  const [syncStatus, setSyncStatus] = useState('connected');
  const itemsPerPage = 12;

  // Modal states
  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure(false);
  const [editModalOpened, { open: openEditModal, close: closeEditModal }] = useDisclosure(false);
  const [deleteModalOpened, { open: openDeleteModal, close: closeDeleteModal }] = useDisclosure(false);
  const [detailsModalOpened, { open: openDetailsModal, close: closeDetailsModal }] = useDisclosure(false);
  const [importExportModalOpened, { open: openImportExportModal, close: closeImportExportModal }] = useDisclosure(false);
  const [helpExpanded, setHelpExpanded] = useState(false);

  // Selected tour for modals
  const [selectedTourId, setSelectedTourId] = useState(null);

  useEffect(() => {
    // URL is the source of truth on navigation/mount; hydrate UI filter state from valid params.
    const statusParam = searchParams.get('status');
    const allowedStatusParams = new Set(['all', 'assigned', 'unassigned', 'active', 'inactive']);

    if (statusParam && allowedStatusParams.has(statusParam) && statusParam !== filterStatus) {
      setFilterStatus(statusParam);
      setCurrentPage(1);
    }
  }, [searchParams, filterStatus]);

  const handleFilterStatusChange = (value) => {
    // UI writes status changes back to URL, while preserving unrelated query params.
    const nextStatus = value || 'all';
    const currentStatusParam = searchParams.get('status') || 'all';

    setFilterStatus(nextStatus);
    setCurrentPage(1);

    if (currentStatusParam === nextStatus) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('status', nextStatus);
    setSearchParams(nextParams);
  };

  // Load data from Firebase
  useEffect(() => {
    setSyncStatus('syncing');
    const toursRef = ref(db, 'tours');
    const driversRef = ref(db, 'drivers');

    const unsubTours = onValue(toursRef, (snapshot) => {
      setTours(snapshot.val() || {});
      setSyncStatus('connected');
    }, (error) => {
      console.error('Tours sync error:', error);
      setSyncStatus('error');
    });

    const unsubDrivers = onValue(driversRef, (snapshot) => {
      setDrivers(snapshot.val() || {});
      setLoading(false);
    });

    return () => {
      unsubTours();
      unsubDrivers();
    };
  }, []);

  // Filter and search tours
  const filteredTours = useMemo(() => {
    return Object.entries(tours).filter(([id, tour]) => {
      const matchesSearch =
        id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (tour.name && tour.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (tour.tourCode && tour.tourCode.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (tour.driverName && tour.driverName.toLowerCase().includes(searchTerm.toLowerCase()));

      const isAssigned = tour.driverName && tour.driverName !== 'TBA';
      const matchesStatus =
        filterStatus === 'all' ||
        (filterStatus === 'assigned' && isAssigned) ||
        (filterStatus === 'unassigned' && !isAssigned) ||
        (filterStatus === 'active' && tour.isActive) ||
        (filterStatus === 'inactive' && !tour.isActive);

      return matchesSearch && matchesStatus;
    });
  }, [tours, searchTerm, filterStatus]);

  // Pagination
  const totalPages = Math.ceil(filteredTours.length / itemsPerPage);
  const paginatedTours = filteredTours.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Stats
  const totalTours = Object.keys(tours).length;
  const assignedTours = Object.values(tours).filter(t => t.driverName && t.driverName !== 'TBA').length;
  const unassignedTours = totalTours - assignedTours;
  const activeTours = Object.values(tours).filter(t => t.isActive).length;
  const totalParticipants = Object.values(tours).reduce((sum, t) => sum + (t.currentParticipants || 0), 0);

  // Modal handlers
  const handleEdit = (tourId) => {
    setSelectedTourId(tourId);
    openEditModal();
  };

  const handleDelete = (tourId) => {
    setSelectedTourId(tourId);
    openDeleteModal();
  };

  const handleViewDetails = (tourId) => {
    setSelectedTourId(tourId);
    openDetailsModal();
  };

  const handleDuplicate = async (tourId) => {
    try {
      const result = await duplicateTour(tourId, 'admin');
      notifications.show({
        title: 'Tour Duplicated',
        message: `Created copy: ${result.id}`,
        color: 'green',
      });
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    }
  };

  const handleTourCreated = (tourId) => {
    setCurrentPage(1);
  };

  const selectedTour = selectedTourId ? tours[selectedTourId] : null;

  if (loading) {
    return (
      <Center style={{ minHeight: 400 }}>
        <Stack align="center" gap="md">
          <Loader size="lg" color="brand" />
          <Text c="dimmed">Loading tours...</Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Group justify="space-between" mb="xl">
        <div>
          <Group gap="sm">
            <Title order={2}>Tours Management</Title>
            <Indicator color={syncStatus === 'connected' ? 'green' : syncStatus === 'syncing' ? 'orange' : 'red'} processing={syncStatus === 'syncing'}>
              <Tooltip label={`Firebase: ${syncStatus}`}>
                <ThemeIcon variant="light" color={syncStatus === 'connected' ? 'green' : 'orange'} size="sm">
                  <IconRefresh size={14} />
                </ThemeIcon>
              </Tooltip>
            </Indicator>
          </Group>
          <Text c="dimmed" size="sm">Create, edit, and manage tours with real-time Firebase sync</Text>
        </div>
        <Group gap="sm">
          <Button variant="light" leftSection={<IconDatabaseExport size={16} />} onClick={openImportExportModal}>
            Import/Export
          </Button>
          <Button leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
            Add Tour
          </Button>
        </Group>
      </Group>

      {/* How to Add Tours Help Section */}
      <Card shadow="sm" padding="md" radius="md" withBorder mb="lg">
        <Group justify="space-between" onClick={() => setHelpExpanded(!helpExpanded)} style={{ cursor: 'pointer' }}>
          <Group gap="sm">
            <ThemeIcon color="blue" variant="light" size="md">
              <IconInfoCircle size={16} />
            </ThemeIcon>
            <div>
              <Text fw={500}>How to Add Tours to Firebase</Text>
              <Text size="xs" c="dimmed">Click to expand for instructions</Text>
            </div>
          </Group>
          <ActionIcon variant="subtle">
            {helpExpanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
          </ActionIcon>
        </Group>

        <Collapse in={helpExpanded}>
          <Divider my="md" />
          <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
            <Paper p="md" radius="md" bg="green.0">
              <Group gap="xs" mb="sm">
                <ThemeIcon color="green" variant="light" size="md">
                  <IconPlus size={16} />
                </ThemeIcon>
                <Text fw={600}>Method 1: Manual Entry</Text>
              </Group>
              <Text size="sm" c="dimmed" mb="sm">
                Click "Add Tour" and fill in tour details. Tour Code becomes the Firebase ID.
              </Text>
              <Code block>
{`// Firebase path: /tours/{tourCode}
{
  "name": "Tour Name",
  "tourCode": "5209L 16",
  "days": 2,
  "startDate": "09/10/2025",
  "endDate": "10/10/2025",
  "isActive": true,
  "driverName": "TBA",
  "maxParticipants": 53,
  "currentParticipants": 0,
  "pickupPoints": [...],
  "itinerary": {...}
}`}
              </Code>
            </Paper>

            <Paper p="md" radius="md" bg="blue.0">
              <Group gap="xs" mb="sm">
                <ThemeIcon color="blue" variant="light" size="md">
                  <IconTemplate size={16} />
                </ThemeIcon>
                <Text fw={600}>Method 2: Templates</Text>
              </Group>
              <Text size="sm" c="dimmed" mb="sm">
                Use pre-configured templates with pickup points and itineraries already set up.
              </Text>
              <Text size="xs" c="dimmed">
                Available: Loch Lomond, Highlands, Edinburgh
              </Text>
            </Paper>

            <Paper p="md" radius="md" bg="orange.0">
              <Group gap="xs" mb="sm">
                <ThemeIcon color="orange" variant="light" size="md">
                  <IconUpload size={16} />
                </ThemeIcon>
                <Text fw={600}>Method 3: CSV Import</Text>
              </Group>
              <Text size="sm" c="dimmed" mb="sm">
                Import multiple tours from CSV. Columns: Tour Code, Name, Days, Start Date, End Date, etc.
              </Text>
              <Text size="xs" c="dimmed">
                Use Export to get a template CSV
              </Text>
            </Paper>
          </SimpleGrid>
        </Collapse>
      </Card>

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="lg" mb="xl">
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Total Tours</Text>
              <Text size="xl" fw={700}>{totalTours}</Text>
            </div>
            <ThemeIcon color="brand" variant="light" size="xl" radius="md">
              <IconMap size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Assigned</Text>
              <Text size="xl" fw={700} c="green">{assignedTours}</Text>
            </div>
            <ThemeIcon color="green" variant="light" size="xl" radius="md">
              <IconCheck size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Unassigned</Text>
              <Text size="xl" fw={700} c="orange">{unassignedTours}</Text>
            </div>
            <ThemeIcon color="orange" variant="light" size="xl" radius="md">
              <IconX size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Active</Text>
              <Text size="xl" fw={700} c="blue">{activeTours}</Text>
            </div>
            <ThemeIcon color="blue" variant="light" size="xl" radius="md">
              <IconPlayerPlay size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Participants</Text>
              <Text size="xl" fw={700} c="grape">{totalParticipants}</Text>
            </div>
            <ThemeIcon color="grape" variant="light" size="xl" radius="md">
              <IconUsers size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Filters */}
      <Card shadow="sm" padding="md" radius="md" withBorder mb="lg">
        <Group justify="space-between" wrap="wrap" gap="md">
          <Group gap="md" wrap="wrap">
            <TextInput
              placeholder="Search tours, codes, drivers..."
              leftSection={<IconSearch size={16} />}
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              style={{ width: 280 }}
            />
            <Select
              placeholder="Filter by status"
              leftSection={<IconFilter size={16} />}
              data={[
                { value: 'all', label: 'All Tours' },
                { value: 'assigned', label: 'Assigned' },
                { value: 'unassigned', label: 'Unassigned (TBA)' },
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ]}
              value={filterStatus}
              onChange={handleFilterStatusChange}
              style={{ width: 180 }}
              clearable={false}
            />
          </Group>
          <Group gap="md">
            <SegmentedControl
              value={viewMode}
              onChange={setViewMode}
              data={[
                { label: 'Grid', value: 'grid' },
                { label: 'Table', value: 'table' },
              ]}
            />
            <Text size="sm" c="dimmed">
              Showing {paginatedTours.length} of {filteredTours.length} tours
            </Text>
          </Group>
        </Group>
      </Card>

      {/* Tours Display */}
      {filteredTours.length === 0 ? (
        <Card shadow="sm" padding="xl" radius="md" withBorder>
          <Center>
            <Stack align="center" gap="md">
              <ThemeIcon color="gray" variant="light" size={60} radius="xl">
                <IconMap size={30} />
              </ThemeIcon>
              <Text c="dimmed" ta="center">
                {totalTours === 0
                  ? 'No tours yet. Click "Add Tour" to create your first tour.'
                  : 'No tours found matching your criteria'}
              </Text>
              {totalTours === 0 && (
                <Button leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
                  Create First Tour
                </Button>
              )}
            </Stack>
          </Center>
        </Card>
      ) : viewMode === 'grid' ? (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing="lg">
          {paginatedTours.map(([id, tour]) => (
            <TourCard
              key={id}
              tourId={id}
              tour={tour}
              drivers={drivers}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              onViewDetails={handleViewDetails}
            />
          ))}
        </SimpleGrid>
      ) : (
        <Card shadow="sm" padding="md" radius="md" withBorder>
          <ScrollArea>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tour</Table.Th>
                  <Table.Th>Code</Table.Th>
                  <Table.Th>Days</Table.Th>
                  <Table.Th>Dates</Table.Th>
                  <Table.Th>Driver</Table.Th>
                  <Table.Th>Capacity</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginatedTours.map(([id, tour]) => {
                  const isAssigned = tour.driverName && tour.driverName !== 'TBA';

                  return (
                    <Table.Tr key={id} className="table-row-clickable" onClick={() => handleViewDetails(id)}>
                      <Table.Td>
                        <Group gap="xs">
                          <ThemeIcon color="brand" variant="light" size="sm">
                            <IconMap size={12} />
                          </ThemeIcon>
                          <Text fw={500} size="sm" truncate="end" style={{ maxWidth: 200 }}>
                            {tour.name || id}
                          </Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Code>{tour.tourCode || id}</Code>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" size="sm">
                          {tour.days || 1} day{(tour.days || 1) > 1 ? 's' : ''}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{formatDateForDisplay(tour.startDate)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs">
                          <Avatar size="xs" radius="xl" color={isAssigned ? 'brand' : 'gray'}>
                            {tour.driverName?.charAt(0) || '?'}
                          </Avatar>
                          <Text size="sm">{tour.driverName || 'TBA'}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{tour.currentParticipants || 0}/{tour.maxParticipants || 53}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={tour.isActive ? 'green' : 'gray'} size="sm">
                          {tour.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </Table.Td>
                      <Table.Td onClick={(e) => e.stopPropagation()}>
                        <Group gap="xs">
                          <Tooltip label="View Details">
                            <ActionIcon variant="light" color="brand" onClick={() => handleViewDetails(id)}>
                              <IconEye size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Edit">
                            <ActionIcon variant="light" color="blue" onClick={() => handleEdit(id)}>
                              <IconEdit size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete">
                            <ActionIcon variant="light" color="red" onClick={() => handleDelete(id)}>
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Card>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <Center mt="xl">
          <Pagination
            total={totalPages}
            value={currentPage}
            onChange={setCurrentPage}
            size="md"
            radius="md"
          />
        </Center>
      )}

      {/* Modals */}
      <CreateTourModal
        opened={createModalOpened}
        onClose={closeCreateModal}
        onSuccess={handleTourCreated}
        userEmail="admin"
      />

      <EditTourModal
        opened={editModalOpened}
        onClose={closeEditModal}
        tourId={selectedTourId}
        tour={selectedTour}
        onSuccess={() => {}}
      />

      <DeleteTourModal
        opened={deleteModalOpened}
        onClose={closeDeleteModal}
        tourId={selectedTourId}
        tourName={selectedTour?.name}
        onConfirm={() => setSelectedTourId(null)}
      />

      <TourDetailsModal
        opened={detailsModalOpened}
        onClose={closeDetailsModal}
        tourId={selectedTourId}
        tour={selectedTour}
        drivers={drivers}
      />

      <ImportExportModal
        opened={importExportModalOpened}
        onClose={closeImportExportModal}
        tours={tours}
        onImportSuccess={() => {}}
      />
    </Box>
  );
}
