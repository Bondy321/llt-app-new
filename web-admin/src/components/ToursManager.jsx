import { useState, useEffect, useMemo } from 'react';
import { ref, onValue, update } from 'firebase/database';
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
} from '@tabler/icons-react';

// Tour Card Component for grid view
function TourCard({ tourId, tour, drivers }) {
  const [opened, { open, close }] = useDisclosure(false);
  const [selectedDriver, setSelectedDriver] = useState('');

  const driverOptions = Object.entries(drivers).map(([id, driver]) => ({
    value: id,
    label: `${driver.name} (${id})`,
  }));

  const handleAssign = async () => {
    if (!selectedDriver) return;

    const driver = drivers[selectedDriver];
    try {
      await update(ref(db), {
        [`tours/${tourId}/driverName`]: driver.name,
        [`tours/${tourId}/driverPhone`]: driver.phone || '',
        [`drivers/${selectedDriver}/assignments/${tourId}`]: true,
      });
      notifications.show({
        title: 'Driver Assigned',
        message: `${driver.name} assigned to tour ${tourId}`,
        color: 'green',
      });
      close();
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
      // Find driver with this tour assignment
      const driverWithTour = Object.entries(drivers).find(([_id, d]) =>
        d.assignments && d.assignments[tourId]
      );

      const updates = {
        [`tours/${tourId}/driverName`]: 'TBA',
        [`tours/${tourId}/driverPhone`]: '',
      };

      if (driverWithTour) {
        updates[`drivers/${driverWithTour[0]}/assignments/${tourId}`] = null;
      }

      await update(ref(db), updates);
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

  return (
    <>
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Group justify="space-between" mb="xs">
          <Badge variant="light" color={isAssigned ? 'green' : 'orange'}>
            {isAssigned ? 'Assigned' : 'TBA'}
          </Badge>
          <Menu shadow="md" width={200}>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray">
                <IconDotsVertical size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconEdit size={14} />} onClick={open}>
                Assign Driver
              </Menu.Item>
              {isAssigned && (
                <Menu.Item
                  leftSection={<IconX size={14} />}
                  color="red"
                  onClick={handleUnassign}
                >
                  Unassign Driver
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>

        <Group gap="xs" mb="sm">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconMap size={16} />
          </ThemeIcon>
          <Text fw={600} size="lg">{tourId}</Text>
        </Group>

        <Stack gap="xs">
          <Group gap="xs">
            <IconUser size={14} color="gray" />
            <Text size="sm" c={isAssigned ? 'dark' : 'dimmed'}>
              {tour.driverName || 'TBA'}
            </Text>
          </Group>
          {tour.driverPhone && (
            <Group gap="xs">
              <IconPhone size={14} color="gray" />
              <Text size="sm" c="dimmed">{tour.driverPhone}</Text>
            </Group>
          )}
        </Stack>

        <Button
          fullWidth
          mt="md"
          variant={isAssigned ? 'light' : 'filled'}
          onClick={open}
        >
          {isAssigned ? 'Reassign' : 'Assign Driver'}
        </Button>
      </Card>

      {/* Assignment Modal */}
      <Modal opened={opened} onClose={close} title="Assign Driver to Tour" centered>
        <Stack gap="md">
          <Paper p="md" radius="md" bg="gray.0">
            <Group gap="xs">
              <ThemeIcon color="brand" variant="light" size="lg">
                <IconMap size={18} />
              </ThemeIcon>
              <div>
                <Text fw={600}>{tourId}</Text>
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
            <Button variant="light" onClick={close}>Cancel</Button>
            <Button onClick={handleAssign} disabled={!selectedDriver}>
              Assign Driver
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

// Main Tours Manager Component
export default function ToursManager() {
  const [tours, setTours] = useState({});
  const [drivers, setDrivers] = useState({});
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [viewMode, setViewMode] = useState('grid');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 12;

  useEffect(() => {
    const toursRef = ref(db, 'tours');
    const driversRef = ref(db, 'drivers');

    const unsubTours = onValue(toursRef, (snapshot) => {
      setTours(snapshot.val() || {});
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
      const matchesSearch = id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (tour.driverName && tour.driverName.toLowerCase().includes(searchTerm.toLowerCase()));

      const isAssigned = tour.driverName && tour.driverName !== 'TBA';
      const matchesFilter = filterStatus === 'all' ||
        (filterStatus === 'assigned' && isAssigned) ||
        (filterStatus === 'unassigned' && !isAssigned);

      return matchesSearch && matchesFilter;
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
          <Title order={2}>Tours Management</Title>
          <Text c="dimmed" size="sm">Manage tour assignments and driver allocations</Text>
        </div>
      </Group>

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg" mb="xl">
        <Paper p="md" radius="md" withBorder>
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
        <Paper p="md" radius="md" withBorder>
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
        <Paper p="md" radius="md" withBorder>
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Unassigned (TBA)</Text>
              <Text size="xl" fw={700} c="orange">{unassignedTours}</Text>
            </div>
            <ThemeIcon color="orange" variant="light" size="xl" radius="md">
              <IconX size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Filters */}
      <Card shadow="sm" padding="md" radius="md" withBorder mb="lg">
        <Group justify="space-between" wrap="wrap" gap="md">
          <Group gap="md">
            <TextInput
              placeholder="Search tours or drivers..."
              leftSection={<IconSearch size={16} />}
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              style={{ width: 300 }}
            />
            <Select
              placeholder="Filter by status"
              leftSection={<IconFilter size={16} />}
              data={[
                { value: 'all', label: 'All Tours' },
                { value: 'assigned', label: 'Assigned' },
                { value: 'unassigned', label: 'Unassigned (TBA)' },
              ]}
              value={filterStatus}
              onChange={(value) => {
                setFilterStatus(value || 'all');
                setCurrentPage(1);
              }}
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
                No tours found matching your criteria
              </Text>
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
            />
          ))}
        </SimpleGrid>
      ) : (
        <Card shadow="sm" padding="md" radius="md" withBorder>
          <ScrollArea>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tour ID</Table.Th>
                  <Table.Th>Driver</Table.Th>
                  <Table.Th>Phone</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginatedTours.map(([id, tour]) => {
                  const isAssigned = tour.driverName && tour.driverName !== 'TBA';
                  return (
                    <Table.Tr key={id}>
                      <Table.Td>
                        <Group gap="xs">
                          <ThemeIcon color="brand" variant="light" size="sm">
                            <IconMap size={12} />
                          </ThemeIcon>
                          <Text fw={500}>{id}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs">
                          <Avatar size="sm" radius="xl" color={isAssigned ? 'brand' : 'gray'}>
                            {tour.driverName?.charAt(0) || '?'}
                          </Avatar>
                          <Text size="sm">{tour.driverName || 'TBA'}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{tour.driverPhone || '-'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={isAssigned ? 'green' : 'orange'}>
                          {isAssigned ? 'Assigned' : 'TBA'}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs">
                          <Tooltip label="Edit assignment">
                            <ActionIcon variant="light" color="brand">
                              <IconEdit size={14} />
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
    </Box>
  );
}
