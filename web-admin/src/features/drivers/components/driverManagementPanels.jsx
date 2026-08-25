import { useEffect, useState } from 'react';
import { ref, update } from 'firebase/database';
import { db } from '../../../firebase';
import { applyDriverAssignmentMutation } from '../../../services/tourService';
import { createDriver } from '../../../services/driverService';
import { APP_SESSION_REVOCATION_REASONS, maskAppSessionId, revokeAppSession, subscribeToAppSession } from '../../../services/appSessionAdminService';
import { notifications } from '@mantine/notifications';
import { formatDateTimeForDisplay } from '../../../utils/dateUtils';
import { ActionIcon, Alert, Avatar, Badge, Box, Button, Card, Divider, Grid, Group, Loader, Modal, Paper, Pill, Select, SimpleGrid, Stack, Tabs, Text, TextInput, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { IconBus, IconCalendar, IconCheck, IconId, IconInfoCircle, IconMap, IconPhone, IconPlus, IconShieldLock, IconUser } from '@tabler/icons-react';
import { normalizeAssignmentTourIdInput, resolveAssignmentTourIdInput } from '../domain/driverAssignmentIdentity';

// Driver Card Component for the sidebar
function DriverCard({ driverId, driver, isSelected, onClick }) {
  const assignedTours = driver.assignedTours || (driver.assignments ? Object.keys(driver.assignments) : []);
  const assignmentCount = assignedTours.length;
  const resolvedCurrentTourId = resolveAssignmentTourIdInput(driver.currentTourId);
  const isActive = !!resolvedCurrentTourId;

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
    try {
      const result = await createDriver({ name, code });

      notifications.show({
        title: 'Driver Created',
        message: `${name} has been added successfully`,
        color: 'green',
      });
      onSuccess(result.id);
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
            label="Driver code"
            placeholder="e.g. BONDY"
            description="We add the D- prefix automatically"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            leftSection={<IconId size={16} />}
            required
          />
          <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
            Driver code is what the driver enters in the mobile app login screen.
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
  const [editName, setEditName] = useState(() => driver?.name || '');
  const [editPhone, setEditPhone] = useState(() => driver?.phone || '');
  const [editCurrentTourId, setEditCurrentTourId] = useState(() => resolveAssignmentTourIdInput(driver?.currentTourId));
  const [newTourId, setNewTourId] = useState('');
  const [saving, setSaving] = useState(false);
  const [assigningTour, setAssigningTour] = useState(false);
  const [appSession, setAppSession] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(Boolean(driver?.authUid));
  const [sessionError, setSessionError] = useState('');
  const [revokeOpened, setRevokeOpened] = useState(false);
  const [revocationReason, setRevocationReason] = useState('');
  const [revokingSession, setRevokingSession] = useState(false);

  const resolvedAssignedTourId = resolveAssignmentTourIdInput(driver?.currentTourId);
  const assignments = resolvedAssignedTourId ? [resolvedAssignedTourId] : [];

  useEffect(() => {
    if (!driver?.authUid) return undefined;
    return subscribeToAppSession({
      authUid: driver.authUid,
      onChange: (session) => {
        setAppSession(session);
        setSessionLoading(false);
      },
      onError: (error) => {
        setSessionError(error?.message || 'Session status could not be loaded.');
        setSessionLoading(false);
      },
    });
  }, [driver?.authUid]);

  const handleRevokeSession = async () => {
    if (!appSession || !revocationReason) return;
    setRevokingSession(true);
    try {
      await revokeAppSession({
        authUid: driver.authUid,
        sessionId: appSession.sessionId,
        reason: revocationReason,
      });
      setRevokeOpened(false);
      setRevocationReason('');
      notifications.show({
        title: 'App session ended',
        message: `${driver.name || driverId} will be returned to secure login.`,
        color: 'green',
      });
    } catch (error) {
      notifications.show({ title: 'Session not ended', message: error.message, color: 'red' });
    } finally {
      setRevokingSession(false);
    }
  };

  const handleSaveDetails = async () => {
    setSaving(true);
    try {
      const nextName = editName.trim();
      const nextPhone = editPhone.trim();
      const currentTourId = resolveAssignmentTourIdInput(driver.currentTourId);
      const nextTourId = normalizeAssignmentTourIdInput(editCurrentTourId);

      if (!nextName) {
        notifications.show({
          title: 'Missing Information',
          message: 'Driver name is required',
          color: 'red',
        });
        return;
      }

      if (nextTourId !== currentTourId) {
        if (nextTourId) {
          await applyDriverAssignmentMutation({
            tourId: nextTourId,
            driverId,
            driverCode: driverId,
            driverInfo: {
              name: nextName,
              phone: nextPhone,
              authUid: driver.authUid || '',
            },
            isAssigned: true,
            driverProfileUpdates: {
              name: nextName,
              phone: nextPhone,
            },
          });
        } else if (currentTourId) {
          await applyDriverAssignmentMutation({
            tourId: currentTourId,
            driverId,
            driverCode: driverId,
            driverInfo: { name: 'TBA', phone: '' },
            isAssigned: false,
            driverProfileUpdates: {
              name: nextName,
              phone: nextPhone,
            },
          });
        }
      } else {
        const updates = {
          [`drivers/${driverId}/name`]: nextName,
          [`drivers/${driverId}/phone`]: nextPhone,
        };

        // Sync name/phone to all assigned tours without changing assignment ownership.
        assignments.forEach((tourId) => {
          updates[`tours/${tourId}/driverName`] = nextName;
          updates[`tours/${tourId}/driverPhone`] = nextPhone;
        });

        await update(ref(db), updates);
      }

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
          authUid: driver.authUid || '',
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

  const createdDate = formatDateTimeForDisplay(driver?.createdAt, 'Unknown');
  const resolvedCurrentTourId = resolveAssignmentTourIdInput(driver?.currentTourId);

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
              {resolvedCurrentTourId && (
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
            Assignment
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
                label="Assigned tour"
                placeholder="Assigned tour ID (for example 5100D_138)"
                description="Changing this uses the same assignment contract as tour dispatch."
                value={editCurrentTourId}
                onChange={(e) => setEditCurrentTourId(e.target.value)}
                leftSection={<IconBus size={16} />}
              />

              <Paper p="sm" radius="md" bg="gray.0">
                <Group gap="xs">
                  <IconCalendar size={14} color="gray" />
                  <Text size="xs" c="dimmed">Created: {createdDate}</Text>
                </Group>
              </Paper>

              <Paper p="md" radius="md" withBorder>
                <Stack gap="xs">
                  <Group justify="space-between" align="flex-start">
                    <Group gap="xs">
                      <ThemeIcon variant="light" color="blue" size="md">
                        <IconShieldLock size={16} />
                      </ThemeIcon>
                      <Box>
                        <Text fw={600} size="sm">Mobile app session</Text>
                        <Text size="xs" c="dimmed">Server-authorised access for this driver device</Text>
                      </Box>
                    </Group>
                    <Badge color={appSession && !appSession.isExpired ? 'green' : 'gray'} variant="light">
                      {sessionLoading ? 'Checking' : appSession && !appSession.isExpired ? 'Active' : 'No active session'}
                    </Badge>
                  </Group>
                  {sessionError && <Alert color="red">{sessionError}</Alert>}
                  {appSession && (
                    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                      <Text size="xs"><strong>Role:</strong> {appSession.principalType}</Text>
                      <Text size="xs"><strong>Session:</strong> {maskAppSessionId(appSession.sessionId)}</Text>
                      <Text size="xs"><strong>Tour:</strong> {appSession.tourId || 'Unassigned'}</Text>
                      <Text size="xs"><strong>Expires:</strong> {formatDateTimeForDisplay(appSession.expiresAtMs, 'Unknown')}</Text>
                    </SimpleGrid>
                  )}
                  {!driver?.authUid && (
                    <Text size="xs" c="dimmed">This driver has not linked a mobile Firebase account yet.</Text>
                  )}
                  {appSession && !appSession.isExpired && (
                    <Button color="red" variant="light" size="xs" onClick={() => setRevokeOpened(true)}>
                      End app session
                    </Button>
                  )}
                </Stack>
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
                Each driver has one active tour. Assigning a new tour safely replaces the previous assignment everywhere the app reads it.
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
                  <Text size="sm" fw={500} mb="sm">Assigned Tour</Text>
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

      <Modal
        opened={revokeOpened}
        onClose={() => !revokingSession && setRevokeOpened(false)}
        title="End mobile app session?"
        centered
      >
        <Stack>
          <Alert color="orange" icon={<IconShieldLock size={18} />}>
            This immediately removes tour, chat, photo and notification access from the current app session. It does not delete the driver account.
          </Alert>
          <Select
            label="Reason"
            placeholder="Select a reason"
            data={APP_SESSION_REVOCATION_REASONS}
            value={revocationReason}
            onChange={(value) => setRevocationReason(value || '')}
            required
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRevokeOpened(false)} disabled={revokingSession}>Cancel</Button>
            <Button color="red" onClick={handleRevokeSession} loading={revokingSession} disabled={!revocationReason}>
              Confirm and end session
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}

// Main Drivers Manager Component

export { CreateDriverModal, DriverCard, DriverDetailsPanel };
