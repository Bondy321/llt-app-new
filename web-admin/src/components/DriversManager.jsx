import { useState, useEffect, useMemo, useRef } from 'react';
import { db } from '../firebase';
import { fetchDriverByExactId, fetchDriverDirectoryPage, subscribeToDriverDirectory } from '../services/adminDirectoryService';
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
  Modal,
  Loader,
  Center,
  Paper,
  ThemeIcon,
  SimpleGrid,
  ScrollArea,
  Grid,
  Select,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconSearch,
  IconUser,
  IconCheck,
  IconBus,
  IconUserPlus,
} from '@tabler/icons-react';

import { CreateDriverModal, DriverCard, DriverDetailsPanel } from '../features/drivers/components/driverManagementPanels';
import { resolveAssignmentTourIdInput } from '../features/drivers/domain/driverAssignmentIdentity';
export function DriversManager() {
  const [drivers, setDrivers] = useState({});
  const [selectedDriverId, setSelectedDriverId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [directoryPage, setDirectoryPage] = useState({ index: 0, cursor: null, hasMore: false, limit: 500 });
  const [pageHistory, setPageHistory] = useState([]);
  const firstPageRef = useRef({ drivers: {}, cursor: null, hasMore: false, limit: 500 });
  const pageIndexRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure(false);

  // Fetch drivers
  useEffect(() => {
    const unsubscribe = subscribeToDriverDirectory(
      db,
      ({ drivers: nextDrivers, atLimit, limit }) => {
        const cursor = Object.keys(nextDrivers).sort().at(-1) || null;
        firstPageRef.current = { drivers: nextDrivers, cursor, hasMore: atLimit, limit };
        if (pageIndexRef.current === 0) {
          setDrivers(nextDrivers);
          setDirectoryPage({ index: 0, cursor, hasMore: atLimit, limit });
        }
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        notifications.show({
          title: 'Drivers unavailable',
          message: error?.message || 'Could not load drivers. Refresh and try again.',
          color: 'red',
        });
      },
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const candidate = searchTerm.trim().toUpperCase();
    if (!/^D-[A-Z0-9_-]{1,77}$/.test(candidate) || drivers[candidate]) return undefined;
    fetchDriverByExactId(db, candidate).then((match) => {
      if (!cancelled && match) setDrivers((current) => ({ ...current, [match.driverId]: match.driver }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [searchTerm, drivers]);

  const handleNextDriverPage = async () => {
    if (!directoryPage.cursor || !directoryPage.hasMore) return;
    try {
      const next = await fetchDriverDirectoryPage(db, { afterKey: directoryPage.cursor });
      setPageHistory((history) => [...history, { drivers, directoryPage }]);
      pageIndexRef.current = directoryPage.index + 1;
      setDrivers(next.drivers);
      setDirectoryPage({ index: pageIndexRef.current, cursor: next.nextCursor, hasMore: next.hasMore, limit: next.limit });
      setSelectedDriverId(null);
    } catch (error) {
      notifications.show({ title: 'Driver page unavailable', message: error?.message || 'Could not load the next driver page.', color: 'red' });
    }
  };

  const handlePreviousDriverPage = () => {
    const previous = pageHistory.at(-1);
    if (!previous) return;
    setPageHistory((history) => history.slice(0, -1));
    pageIndexRef.current = previous.directoryPage.index;
    setDrivers(previous.drivers);
    setDirectoryPage(previous.directoryPage);
    setSelectedDriverId(null);
  };

  const resolveCurrentTourId = (driver) => resolveAssignmentTourIdInput(driver?.currentTourId);

  // Filter drivers by search term
  const filteredDrivers = useMemo(() => {
    return Object.entries(drivers).filter(([id, driver]) =>
      driver.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      id.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [drivers, searchTerm]);

  // Stats
  const totalDrivers = Object.keys(drivers).length;
  const activeDrivers = Object.values(drivers).filter((d) => !!resolveCurrentTourId(d)).length;

  const handleDriverCreated = (newId) => {
    // A newly created key can sort beyond the bounded live window. Drive it
    // through the exact-ID lookup path so the details panel remains reachable.
    setSearchTerm(newId);
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
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Drivers on page {directoryPage.index + 1}</Text>
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
            <Group justify="space-between" mt="sm">
              <Button size="xs" variant="light" disabled={pageHistory.length === 0} onClick={handlePreviousDriverPage}>Previous</Button>
              <Text size="xs" c="dimmed">Bounded directory page {directoryPage.index + 1}</Text>
              <Button size="xs" variant="light" disabled={!directoryPage.hasMore} onClick={handleNextDriverPage}>Next</Button>
            </Group>
          </Card>
        </Grid.Col>

        {/* Main Panel - Driver Details */}
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Card shadow="sm" padding="lg" radius="md" withBorder style={{ minHeight: 'calc(100vh - 340px)' }}>
            {selectedDriverId && drivers[selectedDriverId] ? (
              <DriverDetailsPanel
                key={`${selectedDriverId}:${drivers[selectedDriverId]?.authUid || 'unbound'}`}
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
