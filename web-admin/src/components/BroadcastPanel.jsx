import { useState, useEffect } from 'react';
import {
  ref,
  push,
  set,
  onValue,
  update,
  query,
  limitToLast,
  orderByChild,
} from 'firebase/database';
import { db, auth } from '../firebase';
import { notifications } from '@mantine/notifications';
import {
  Card,
  Text,
  Title,
  Group,
  Button,
  TextInput,
  Textarea,
  Stack,
  Box,
  Badge,
  Paper,
  ThemeIcon,
  SimpleGrid,
  Select,
  Divider,
  Alert,
  ScrollArea,
  Drawer,
} from '@mantine/core';
import {
  IconSpeakerphone,
  IconSend,
  IconMap,
  IconUsers,
  IconCheck,
  IconMessage,
  IconBroadcast,
  IconHistory,
  IconInfoCircle,
  IconRefresh,
  IconX,
  IconChevronRight,
} from '@tabler/icons-react';

// Message Templates
const messageTemplates = [
  { value: 'arriving', label: 'Bus Arriving', message: 'The bus is arriving in 5 minutes. Please make your way to the pickup point.' },
  { value: 'delayed', label: 'Delay Notice', message: 'We apologize for the delay. The bus will arrive in approximately 15 minutes.' },
  { value: 'departed', label: 'Departed', message: 'The tour has now departed. Thank you for joining us today!' },
  { value: 'weather', label: 'Weather Update', message: 'Due to weather conditions, please dress appropriately for outdoor activities.' },
  { value: 'reminder', label: 'General Reminder', message: 'This is a reminder for all passengers on this tour.' },
  { value: 'custom', label: 'Custom Message', message: '' },
];

// Recent Broadcast Item Component
const MAX_HISTORY = 100;

function statusColor(status) {
  if (status === 'sent') return 'green';
  if (status === 'failed') return 'red';
  return 'yellow';
}

function formatDateTime(value) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 'Unknown time';
  return new Date(parsed).toLocaleString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function BroadcastHistoryItem({ broadcast, onViewDetails, onRetry }) {
  return (
    <Paper p="sm" radius="md" withBorder>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <ThemeIcon color="orange" variant="light" size="sm">
            <IconSpeakerphone size={12} />
          </ThemeIcon>
          <Badge size="sm" variant="light">{broadcast.tourId}</Badge>
          <Badge size="sm" color={statusColor(broadcast.status)} variant="light">
            {broadcast.status || 'queued'}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">
          {formatDateTime(broadcast.createdAt)}
        </Text>
      </Group>
      <Text size="sm" lineClamp={2} mb="xs">{broadcast.message}</Text>
      <Group justify="space-between">
        <Button size="xs" variant="subtle" rightSection={<IconChevronRight size={14} />} onClick={() => onViewDetails(broadcast)}>
          Details
        </Button>
        {broadcast.status === 'failed' && (
          <Button size="xs" color="orange" leftSection={<IconRefresh size={14} />} onClick={() => onRetry(broadcast)}>
            Retry
          </Button>
        )}
      </Group>
    </Paper>
  );
}

// Main Broadcast Panel Component
export function BroadcastPanel() {
  const [tourId, setTourId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('custom');
  const [tours, setTours] = useState({});
  const [loadingTours, setLoadingTours] = useState(true);
  const [broadcastHistory, setBroadcastHistory] = useState([]);
  const [selectedBroadcast, setSelectedBroadcast] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [tourFilter, setTourFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('');

  // Fetch tours for the dropdown
  useEffect(() => {
    const toursRef = ref(db, 'tours');
    const unsubscribe = onValue(toursRef, (snapshot) => {
      setTours(snapshot.val() || {});
      setLoadingTours(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const broadcastsQuery = query(
      ref(db, 'admin_broadcasts'),
      orderByChild('createdAt'),
      limitToLast(MAX_HISTORY),
    );

    const unsubscribe = onValue(broadcastsQuery, (snapshot) => {
      const data = snapshot.val() || {};
      const records = Object.entries(data)
        .map(([id, value]) => ({ id, ...value }))
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
      setBroadcastHistory(records);
    });

    return () => unsubscribe();
  }, []);

  // Tour options for Select
  const tourOptions = Object.entries(tours).map(([id, tour]) => ({
    value: id,
    label: `${id} - ${tour.driverName || 'TBA'}`,
  }));

  // Handle template change
  const handleTemplateChange = (value) => {
    setSelectedTemplate(value);
    const template = messageTemplates.find(t => t.value === value);
    if (template && template.message) {
      setMessage(template.message);
    }
  };

  // Handle send broadcast
  const sendBroadcast = async ({ broadcastId, targetTourId, text }) => {
    const nowIso = new Date().toISOString();

    const broadcastRef = ref(db, `admin_broadcasts/${broadcastId}`);
    await update(broadcastRef, {
      status: 'queued',
      updatedAt: nowIso,
      lastError: null,
    });

    try {
      const messagesRef = ref(db, `chats/${targetTourId}/messages`);
      const newMessageRef = push(messagesRef);

      await set(newMessageRef, {
        text: `ANNOUNCEMENT: ${text}`,
        senderName: 'Loch Lomond Travel HQ',
        senderId: 'admin_hq_broadcast',
        senderUid: auth.currentUser?.uid || null,
        timestamp: nowIso,
        isDriver: true,
      });

      await update(broadcastRef, {
        status: 'sent',
        chatMessageId: newMessageRef.key,
        sentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
      });

      return { success: true };
    } catch (error) {
      await update(broadcastRef, {
        status: 'failed',
        lastError: error.message || 'Unknown send error',
        updatedAt: new Date().toISOString(),
      });

      return { success: false, error };
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();

    if (!tourId) {
      notifications.show({
        title: 'Tour Required',
        message: 'Please select a tour to broadcast to',
        color: 'red',
      });
      return;
    }

    if (!message.trim()) {
      notifications.show({
        title: 'Message Required',
        message: 'Please enter a message to broadcast',
        color: 'red',
      });
      return;
    }

    setLoading(true);

    try {
      const createdAt = new Date().toISOString();
      const broadcastRef = push(ref(db, 'admin_broadcasts'));
      await set(broadcastRef, {
        tourId,
        message,
        createdAt,
        createdBy: auth.currentUser?.email || auth.currentUser?.uid || 'unknown_admin',
        chatMessageId: null,
        status: 'queued',
        updatedAt: createdAt,
      });

      const sendResult = await sendBroadcast({
        broadcastId: broadcastRef.key,
        targetTourId: tourId,
        text: message,
      });

      if (!sendResult.success) {
        throw sendResult.error;
      }

      notifications.show({
        title: 'Broadcast Sent!',
        message: `Announcement sent to tour ${tourId}`,
        color: 'green',
        icon: <IconCheck size={16} />,
      });

      // Reset form
      setMessage('');
      setSelectedTemplate('custom');
    } catch (error) {
      notifications.show({
        title: 'Broadcast Failed',
        message: error.message,
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (broadcast) => {
    setLoading(true);
    const retryCount = (broadcast.retryCount || 0) + 1;

    await update(ref(db, `admin_broadcasts/${broadcast.id}`), {
      retryCount,
      updatedAt: new Date().toISOString(),
    });

    const sendResult = await sendBroadcast({
      broadcastId: broadcast.id,
      targetTourId: broadcast.tourId,
      text: broadcast.message,
    });

    if (sendResult.success) {
      notifications.show({
        title: 'Retry Succeeded',
        message: `Broadcast ${broadcast.id} sent successfully.`,
        color: 'green',
      });
    } else {
      notifications.show({
        title: 'Retry Failed',
        message: sendResult.error?.message || 'Unknown retry error',
        color: 'red',
      });
    }

    setLoading(false);
  };

  const filteredHistory = broadcastHistory.filter((broadcast) => {
    const matchesStatus = statusFilter === 'all' || broadcast.status === statusFilter;
    const matchesTour = tourFilter === 'all' || broadcast.tourId === tourFilter;

    let matchesDate = true;
    if (dateFilter) {
      const parsed = Date.parse(broadcast.createdAt || '');
      matchesDate = !Number.isNaN(parsed)
        && new Date(parsed).toISOString().slice(0, 10) === dateFilter;
    }

    return matchesStatus && matchesTour && matchesDate;
  });

  // Stats
  const totalTours = Object.keys(tours).length;
  const assignedTours = Object.values(tours).filter(t => t.driverName && t.driverName !== 'TBA').length;

  return (
    <Box>
      {/* Header */}
      <Group justify="space-between" mb="xl">
        <div>
          <Title order={2}>Broadcast System</Title>
          <Text c="dimmed" size="sm">Send announcements to tour passengers</Text>
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
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Active Tours</Text>
              <Text size="xl" fw={700} c="green">{assignedTours}</Text>
            </div>
            <ThemeIcon color="green" variant="light" size="xl" radius="md">
              <IconUsers size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder>
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Broadcasts Today</Text>
              <Text size="xl" fw={700} c="orange">{broadcastHistory.length}</Text>
            </div>
            <ThemeIcon color="orange" variant="light" size="xl" radius="md">
              <IconSpeakerphone size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        {/* Broadcast Form */}
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group gap="xs" mb="lg">
            <ThemeIcon color="orange" variant="light" size="lg" radius="md">
              <IconBroadcast size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600}>New Broadcast</Text>
              <Text size="xs" c="dimmed">Send an announcement to passengers</Text>
            </div>
          </Group>

          <form onSubmit={handleSend}>
            <Stack gap="md">
              {/* Tour Selection */}
              <Select
                label="Target Tour"
                placeholder="Select a tour"
                data={tourOptions}
                value={tourId}
                onChange={setTourId}
                searchable
                clearable
                leftSection={<IconMap size={16} />}
                disabled={loadingTours}
                description="Choose which tour to broadcast to"
              />

              {/* Message Template */}
              <Select
                label="Message Template"
                placeholder="Choose a template or write custom"
                data={messageTemplates.map(t => ({ value: t.value, label: t.label }))}
                value={selectedTemplate}
                onChange={handleTemplateChange}
                leftSection={<IconMessage size={16} />}
              />

              {/* Message Content */}
              <Textarea
                label="Message"
                placeholder="Enter your announcement message..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                minRows={4}
                maxRows={6}
                description={`${message.length} characters`}
              />

              <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
                This message will be sent as a push notification to all passengers subscribed to the selected tour.
              </Alert>

              <Button
                type="submit"
                loading={loading}
                fullWidth
                size="lg"
                color="orange"
                leftSection={<IconSend size={18} />}
                disabled={!tourId || !message.trim()}
              >
                Send Broadcast
              </Button>
            </Stack>
          </form>
        </Card>

        {/* Broadcast History & Info */}
        <Stack gap="lg">
          {/* Quick Tips */}
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Group gap="xs" mb="md">
              <ThemeIcon color="blue" variant="light" size="lg" radius="md">
                <IconInfoCircle size={20} />
              </ThemeIcon>
              <Text fw={600}>Tips for Effective Broadcasts</Text>
            </Group>
            <Stack gap="xs">
              <Paper p="sm" radius="md" bg="gray.0">
                <Group gap="xs">
                  <IconCheck size={14} color="green" />
                  <Text size="sm">Keep messages clear and concise</Text>
                </Group>
              </Paper>
              <Paper p="sm" radius="md" bg="gray.0">
                <Group gap="xs">
                  <IconCheck size={14} color="green" />
                  <Text size="sm">Include specific times when relevant</Text>
                </Group>
              </Paper>
              <Paper p="sm" radius="md" bg="gray.0">
                <Group gap="xs">
                  <IconCheck size={14} color="green" />
                  <Text size="sm">Use templates for common announcements</Text>
                </Group>
              </Paper>
              <Paper p="sm" radius="md" bg="gray.0">
                <Group gap="xs">
                  <IconCheck size={14} color="green" />
                  <Text size="sm">Double-check the target tour before sending</Text>
                </Group>
              </Paper>
            </Stack>
          </Card>

          {/* Recent Broadcasts */}
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Group justify="space-between" mb="md">
              <Group gap="xs">
                <ThemeIcon color="gray" variant="light" size="lg" radius="md">
                  <IconHistory size={20} />
                </ThemeIcon>
                <Text fw={600}>Recent Broadcasts</Text>
              </Group>
              <Badge variant="light" color="gray">{filteredHistory.length}</Badge>
            </Group>

            <Stack gap="xs" mb="md">
              <Select
                label="Status filter"
                data={[
                  { value: 'all', label: 'All' },
                  { value: 'queued', label: 'Queued' },
                  { value: 'sent', label: 'Sent' },
                  { value: 'failed', label: 'Failed' },
                ]}
                value={statusFilter}
                onChange={(value) => setStatusFilter(value || 'all')}
              />
              <Select
                label="Tour filter"
                data={[{ value: 'all', label: 'All tours' }, ...tourOptions]}
                value={tourFilter}
                onChange={(value) => setTourFilter(value || 'all')}
              />
              <TextInput
                label="Date filter"
                type="date"
                value={dateFilter}
                onChange={(event) => setDateFilter(event.currentTarget.value)}
              />
            </Stack>

            {filteredHistory.length > 0 ? (
              <ScrollArea h={250}>
                <Stack gap="xs">
                  {filteredHistory.map((broadcast) => (
                    <BroadcastHistoryItem
                      key={broadcast.id}
                      broadcast={broadcast}
                      onViewDetails={setSelectedBroadcast}
                      onRetry={handleRetry}
                    />
                  ))}
                </Stack>
              </ScrollArea>
            ) : (
              <Paper p="xl" radius="md" bg="gray.0" ta="center">
                <ThemeIcon color="gray" variant="light" size="xl" radius="xl" mb="sm">
                  <IconSpeakerphone size={24} />
                </ThemeIcon>
                <Text c="dimmed" size="sm">No broadcasts sent yet this session</Text>
              </Paper>
            )}
          </Card>
        </Stack>
      </SimpleGrid>

      <Drawer
        opened={Boolean(selectedBroadcast)}
        onClose={() => setSelectedBroadcast(null)}
        title="Broadcast details"
        position="right"
      >
        {selectedBroadcast && (
          <Stack gap="xs">
            <Text><strong>ID:</strong> {selectedBroadcast.id}</Text>
            <Text><strong>Tour:</strong> {selectedBroadcast.tourId}</Text>
            <Text><strong>Status:</strong> {selectedBroadcast.status || 'queued'}</Text>
            <Text><strong>Created:</strong> {formatDateTime(selectedBroadcast.createdAt)}</Text>
            <Text><strong>Created by:</strong> {selectedBroadcast.createdBy || 'Unknown'}</Text>
            <Text><strong>Chat message ID:</strong> {selectedBroadcast.chatMessageId || 'Not yet linked'}</Text>
            {selectedBroadcast.lastError && (
              <Alert color="red" icon={<IconX size={16} />}>Last error: {selectedBroadcast.lastError}</Alert>
            )}
            <Divider />
            <Text size="sm" fw={600}>Message</Text>
            <Paper withBorder p="sm" radius="md">
              <Text size="sm">{selectedBroadcast.message}</Text>
            </Paper>
          </Stack>
        )}
      </Drawer>
    </Box>
  );
}
