import { useState, useEffect } from 'react';
import { ref, push, set, onValue } from 'firebase/database';
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
  Timeline,
  ScrollArea,
  Avatar,
  Center,
  Loader,
  Tabs,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconSpeakerphone,
  IconSend,
  IconMap,
  IconUsers,
  IconClock,
  IconCheck,
  IconAlertCircle,
  IconMessage,
  IconBroadcast,
  IconHistory,
  IconInfoCircle,
  IconRefresh,
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
function BroadcastHistoryItem({ broadcast }) {
  return (
    <Paper p="sm" radius="md" withBorder>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <ThemeIcon color="orange" variant="light" size="sm">
            <IconSpeakerphone size={12} />
          </ThemeIcon>
          <Badge size="sm" variant="light">{broadcast.tourId}</Badge>
        </Group>
        <Text size="xs" c="dimmed">
          {new Date(broadcast.timestamp).toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </Group>
      <Text size="sm" lineClamp={2}>{broadcast.message}</Text>
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

  // Fetch tours for the dropdown
  useEffect(() => {
    const toursRef = ref(db, 'tours');
    const unsubscribe = onValue(toursRef, (snapshot) => {
      setTours(snapshot.val() || {});
      setLoadingTours(false);
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
      // Create message in chat
      const messagesRef = ref(db, `chats/${tourId}/messages`);
      const newMessageRef = push(messagesRef);

      await set(newMessageRef, {
        text: `ANNOUNCEMENT: ${message}`,
        senderName: 'Loch Lomond Travel HQ',
        senderId: 'admin_hq_broadcast',
        senderUid: auth.currentUser?.uid || null,
        timestamp: new Date().toISOString(),
        isDriver: true,
      });

      // Add to local history
      setBroadcastHistory(prev => [
        {
          tourId,
          message,
          timestamp: new Date().toISOString(),
        },
        ...prev.slice(0, 9), // Keep last 10
      ]);

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
              <Badge variant="light" color="gray">{broadcastHistory.length}</Badge>
            </Group>

            {broadcastHistory.length > 0 ? (
              <ScrollArea h={250}>
                <Stack gap="xs">
                  {broadcastHistory.map((broadcast, index) => (
                    <BroadcastHistoryItem key={index} broadcast={broadcast} />
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
    </Box>
  );
}
