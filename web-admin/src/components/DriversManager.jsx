import { useState, useEffect, useMemo } from 'react';
import { ref, onValue, update } from 'firebase/database';
import { db } from '../firebase';
import { applyDriverAssignmentMutation } from '../services/tourService';
import { notifications } from '@mantine/notifications';
import {
  Card,
  Text,
  Title,
  Group,
  Button,
  TextInput,
  Stack,
  Box,
  Badge,
  ActionIcon,
  Tooltip,
  Modal,
  Loader,
  Center,
  Paper,
  ThemeIcon,
  Divider,
  Avatar,
  SimpleGrid,
  ScrollArea,
  Grid,
  Tabs,
  Alert,
  Pill,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconSearch,
  IconUser,
  IconPhone,
  IconPlus,
  IconCheck,
  IconBus,
  IconMap,
  IconId,
  IconUserPlus,
  IconInfoCircle,
  IconCalendar,
} from '@tabler/icons-react';

// Driver Card Component for the sidebar
function DriverCard({ driverId, driver, isSelected, onClick }) {
  const assignedTours = driver.assignedTours || (driver.assignments ? Object.keys(driver.assignments) : []);
  const assignmentCount = assignedTours.length;
  const isActive = !!driver.currentTourId;

  return (
    <Paper
      p="sm"
      radius="md"
      withBorder
      onClick={onClick}
      style={{
        cursor: 'pointer',
        borderColor: isSelected ? 'var(--mantine-color-brand-5)' : undefined,
        backgroundColor: isSelected ? 'var(--mantine-color-brand-0)' : undefined,
        borderWidth: isSelected ? 2 : 1,
        transition: 'all 0.15s ease',
      }}
    >
      <Group gap="sm" wrap="nowrap">
        <Avatar size="md" radius="xl" color={isActive ? 'green' : 'brand'}>
          {driver.name?.charAt(0) || '?'}
        </Avatar>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" gap="xs">
            <Text fw={600} size="sm" truncate="end">
              {driver.name || 'Unknown'}
            </Text>
            {isActive && (
              <Badge size="xs" variant="dot" color="green">Active</Badge>
            )}
          </Group>
          <Group gap={4}>
            <Badge size="xs" variant="light" color="gray">{driverId}</Badge>
            {assignmentCount > 0 && (
              <Badge size="xs" variant="light" color="blue">
                {assignmentCount} tour{assignmentCount !== 1 ? 's' : ''}
              </Badge>
            )}
          </Group>
        </Box>
      </Group>
    </Paper>
  );
}

// Create Driver Modal Component
function CreateDriverModal({ opened, onClose, onSuccess }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!name.trim() || !code.trim()) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please fill in all fields',
        color: 'red',
      });
      return;
    }

    setLoading(true);
    const cleanCode = code.trim().toUpperCase();
    const id = cleanCode.startsWith('D-') ? cleanCode : `D-${cleanCode}`;

    try {
      await update(ref(db), {
        [`drivers/${id}`]: {
          name: name.trim(),
          createdAt: new Date().toISOString(),
          assignments: {},
        },
      });

      notifications.show({
        title: 'Driver Created',
        message: `${name} has been added successfully`,
        color: 'green',
      });
      onSuccess(id);
      setName('');
      setCode('');
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
          <ThemeIcon color="brand" variant="light" size="md">
            <IconUserPlus size={16} />
          </ThemeIcon>
          <Text fw={600}>Add New Driver</Text>
        </Group>
      }
      centered
      size="md"
    >
      <form onSubmit={handleCreate}>
        <Stack gap="md">
          <TextInput
            label="Driver Name"
            placeholder="e.g. John Smith"
            value={name}
            onChange={(e) => setName(e.target.value)}
            leftSection={<IconUser size={16} />}
            required
          />
          <TextInput
            label="Login Code"
            placeholder="e.g. JOHN"
            description="Will be prefixed with 'D-' automatically"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            leftSection={<IconId size={16} />}
            required
          />
          <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
            The login code is used by drivers to access the mobile app
          </Alert>
          <Group justify="flex-end" mt="md">
            <Button variant="light" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading} leftSection={<IconPlus size={16} />}>
              Create Driver
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// Driver Details Panel Component
function DriverDetailsPanel({ driverId, driver }) {
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editActiveTour, setEditActiveTour] = useState('');
  const [newTourId, setNewTourId] = useState('');
  const [saving, setSaving] = useState(false);
  const [assigningTour, setAssigningTour] = useState(false);

  // Update local state when driver changes
  useEffect(() => {
    if (driver) {
      setEditName(driver.name || '');
      setEditPhone(driver.phone || '');
      setEditActiveTour(driver.currentTourId || '');
    }
  }, [driver]);

  const assignments = driver?.assignedTours || (driver?.assignments ? Object.keys(driver.assignments) : []);

  const handleSaveDetails = async () => {
    setSaving(true);
    try {
      const updates = {
        [`drivers/${driverId}/name`]: editName,
        [`drivers/${driverId}/phone`]: editPhone,
        [`drivers/${driverId}/currentTourId`]: editActiveTour || null,
        [`drivers/${driverId}/currentTourCode`]: editActiveTour || null,
      };

      // Sync name/phone to all assigned tours
      assignments.forEach((tourId) => {
        updates[`tours/${tourId}/driverName`] = editName;
        updates[`tours/${tourId}/driverPhone`] = editPhone;
      });

      await update(ref(db), updates);
      notifications.show({
        title: 'Changes Saved',
        message: 'Driver details updated successfully',
        color: 'green',
      });
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAddTour = async () => {
    if (!newTourId.trim()) return;

    setAssigningTour(true);
    const tourId = newTourId.trim();

    try {
      await applyDriverAssignmentMutation({
        tourId,
        driverId,
        driverCode: driverId,
        driverInfo: {
          name: driver.name,
          phone: driver.phone || '',
        },
        isAssigned: true,
      });

      notifications.show({
        title: 'Tour Assigned',
        message: `${tourId} assigned to ${driver.name}`,
        color: 'green',
      });
      setNewTourId('');
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    } finally {
      setAssigningTour(false);
    }
  };

  const handleRemoveTour = async (tourId) => {
    try {
      await applyDriverAssignmentMutation({
        tourId,
        driverId,
        driverCode: driverId,
        driverInfo: { name: 'TBA', phone: '' },
        isAssigned: false,
      });

      notifications.show({
        title: 'Tour Unassigned',
        message: `${tourId} removed from ${driver.name}`,
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

  const createdDate = driver?.createdAt
    ? new Date(driver.createdAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : 'Unknown';

  return (
    <Box>
      {/* Header */}
      <Group justify="space-between" mb="lg">
        <Group gap="md">
          <Avatar size="lg" radius="xl" color="brand">
            {driver?.name?.charAt(0) || '?'}
          </Avatar>
          <div>
            <Title order={3}>{driver?.name}</Title>
            <Group gap="xs">
              <Badge variant="filled" color="brand">{driverId}</Badge>
              {driver?.currentTourId && (
                <Badge variant="dot" color="green">On Tour</Badge>
              )}
            </Group>
          </div>
        </Group>
      </Group>

      <Tabs defaultValue="details">
        <Tabs.List mb="md">
          <Tabs.Tab value="details" leftSection={<IconUser size={14} />}>
            Details
          </Tabs.Tab>
          <Tabs.Tab value="tours" leftSection={<IconMap size={14} />}>
            Tours ({assignments.length})
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="details">
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Stack gap="md">
              <TextInput
                label="Full Name"
                placeholder="Enter driver's name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                leftSection={<IconUser size={16} />}
              />

              <TextInput
                label="Phone Number"
                placeholder="+44 7700 900000"
                value={editPhone}
                onChange={(e) => setEditPhone(e.target.value)}
                leftSection={<IconPhone size={16} />}
              />

              <TextInput
                label="Current Active Tour"
                placeholder="Tour ID currently being driven"
                description="This indicates which tour the driver is currently on"
                value={editActiveTour}
                onChange={(e) => setEditActiveTour(e.target.value)}
                leftSection={<IconBus size={16} />}
              />

              <Paper p="sm" radius="md" bg="gray.0">
                <Group gap="xs">
                  <IconCalendar size={14} color="gray" />
                  <Text size="xs" c="dimmed">Created: {createdDate}</Text>
                </Group>
              </Paper>

              <Button
                onClick={handleSaveDetails}
                loading={saving}
                leftSection={<IconCheck size={16} />}
              >
                Save Changes
              </Button>
            </Stack>
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="tours">
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Stack gap="md">
              <Text size="sm" c="dimmed">
                Manage the tours assigned to this driver. Adding a tour will automatically update the tour's driver information.
              </Text>

              <Group gap="sm">
                <TextInput
                  placeholder="Enter Tour ID (e.g. 5100D_138)"
                  value={newTourId}
                  onChange={(e) => setNewTourId(e.target.value)}
                  style={{ flex: 1 }}
                  leftSection={<IconMap size={16} />}
                />
                <Button
                  onClick={handleAddTour}
                  loading={assigningTour}
                  disabled={!newTourId.trim()}
                >
                  Assign Tour
                </Button>
              </Group>

              <Divider />

              {assignments.length > 0 ? (
                <Box>
                  <Text size="sm" fw={500} mb="sm">Assigned Tours</Text>
                  <Group gap="xs">
                    {assignments.map((tourId) => (
                      <Pill
                        key={tourId}
                        size="md"
                        withRemoveButton
                        onRemove={() => handleRemoveTour(tourId)}
                        styles={{
                          root: {
                            backgroundColor: 'var(--mantine-color-blue-0)',
                            color: 'var(--mantine-color-blue-7)',
                          },
                        }}
                      >
                        {tourId}
                      </Pill>
                    ))}
                  </Group>
                </Box>
              ) : (
                <Paper p="xl" radius="md" bg="gray.0" ta="center">
                  <ThemeIcon color="gray" variant="light" size="xl" radius="xl" mb="sm">
                    <IconMap size={24} />
                  </ThemeIcon>
                  <Text c="dimmed" size="sm">No tours assigned yet</Text>
                </Paper>
              )}
            </Stack>
          </Card>
        </Tabs.Panel>
      </Tabs>
    </Box>
  );
}

// Main Drivers Manager Component
export function DriversManager() {
  const [drivers, setDrivers] = useState({});
  const [selectedDriverId, setSelectedDriverId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure(false);

  // Fetch drivers
  useEffect(() => {
    const driversRef = ref(db, 'drivers');
    const unsubscribe = onValue(driversRef, (snapshot) => {
      setDrivers(snapshot.val() || {});
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Filter drivers by search term
  const filteredDrivers = useMemo(() => {
    return Object.entries(drivers).filter(([id, driver]) =>
      driver.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      id.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [drivers, searchTerm]);

  // Stats
  const totalDrivers = Object.keys(drivers).length;
  const activeDrivers = Object.values(drivers).filter((d) => d.currentTourId).length;

  const handleDriverCreated = (newId) => {
    setSelectedDriverId(newId);
  };

  if (loading) {
    return (
      <Center style={{ minHeight: 400 }}>
        <Stack align="center" gap="md">
          <Loader size="lg" color="brand" />
          <Text c="dimmed">Loading drivers...</Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Group justify="space-between" mb="xl">
        <div>
          <Title order={2}>Driver Management</Title>
          <Text c="dimmed" size="sm">Manage driver profiles and tour assignments</Text>
        </div>
        <Button leftSection={<IconUserPlus size={16} />} onClick={openCreateModal}>
          Add Driver
        </Button>
      </Group>

      {/* Stats */}
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="lg" mb="xl">
        <Paper p="md" radius="md" withBorder>
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Total Drivers</Text>
              <Text size="xl" fw={700}>{totalDrivers}</Text>
            </div>
            <ThemeIcon color="brand" variant="light" size="xl" radius="md">
              <IconUser size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder>
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Active Now</Text>
              <Text size="xl" fw={700} c="green">{activeDrivers}</Text>
            </div>
            <ThemeIcon color="green" variant="light" size="xl" radius="md">
              <IconBus size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder>
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Available</Text>
              <Text size="xl" fw={700} c="blue">{totalDrivers - activeDrivers}</Text>
            </div>
            <ThemeIcon color="blue" variant="light" size="xl" radius="md">
              <IconCheck size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder>
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Showing</Text>
              <Text size="xl" fw={700}>{filteredDrivers.length}</Text>
            </div>
            <ThemeIcon color="gray" variant="light" size="xl" radius="md">
              <IconSearch size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Main Content */}
      <Grid gutter="lg">
        {/* Sidebar - Driver List */}
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Card shadow="sm" padding="md" radius="md" withBorder style={{ height: 'calc(100vh - 340px)', display: 'flex', flexDirection: 'column' }}>
            <TextInput
              placeholder="Search drivers..."
              leftSection={<IconSearch size={16} />}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              mb="md"
            />

            <ScrollArea style={{ flex: 1 }}>
              <Stack gap="xs">
                {filteredDrivers.length > 0 ? (
                  filteredDrivers.map(([id, driver]) => (
                    <DriverCard
                      key={id}
                      driverId={id}
                      driver={driver}
                      isSelected={selectedDriverId === id}
                      onClick={() => setSelectedDriverId(id)}
                    />
                  ))
                ) : (
                  <Paper p="xl" radius="md" bg="gray.0" ta="center">
                    <ThemeIcon color="gray" variant="light" size="xl" radius="xl" mb="sm">
                      <IconUser size={24} />
                    </ThemeIcon>
                    <Text c="dimmed" size="sm">
                      {searchTerm ? 'No drivers match your search' : 'No drivers found'}
                    </Text>
                  </Paper>
                )}
              </Stack>
            </ScrollArea>
          </Card>
        </Grid.Col>

        {/* Main Panel - Driver Details */}
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Card shadow="sm" padding="lg" radius="md" withBorder style={{ minHeight: 'calc(100vh - 340px)' }}>
            {selectedDriverId && drivers[selectedDriverId] ? (
              <DriverDetailsPanel
                driverId={selectedDriverId}
                driver={drivers[selectedDriverId]}
              />
            ) : (
              <Center style={{ height: '100%', minHeight: 400 }}>
                <Stack align="center" gap="md">
                  <ThemeIcon color="gray" variant="light" size={80} radius="xl">
                    <IconUser size={40} />
                  </ThemeIcon>
                  <div style={{ textAlign: 'center' }}>
                    <Title order={3} c="dimmed">Select a Driver</Title>
                    <Text c="dimmed" size="sm" mt="xs">
                      Choose a driver from the list to view and edit their details
                    </Text>
                  </div>
                  <Button
                    variant="light"
                    leftSection={<IconUserPlus size={16} />}
                    onClick={openCreateModal}
                  >
                    Or Add a New Driver
                  </Button>
                </Stack>
              </Center>
            )}
          </Card>
        </Grid.Col>
      </Grid>

      {/* Create Driver Modal */}
      <CreateDriverModal
        opened={createModalOpened}
        onClose={closeCreateModal}
        onSuccess={handleDriverCreated}
      />
    </Box>
  );
}
