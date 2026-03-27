import { useMemo, useState, useEffect } from 'react';
import { ref, push, set, onValue, query, orderByChild, limitToLast } from 'firebase/database';
import { db, auth } from '../firebase';
import { notifications } from '@mantine/notifications';
import {
  Card,
  Text,
  Title,
  Group,
  Button,
  Textarea,
  Stack,
  Box,
  Badge,
  Paper,
  ThemeIcon,
  SimpleGrid,
  Select,
  Alert,
  ScrollArea,
  Loader,
  Progress,
  Divider,
  RingProgress,
  ActionIcon,
  Tooltip,
  TextInput,
} from '@mantine/core';
import { formatTimeForDisplay, toEpochMsStrict } from '../utils/dateUtils';
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
  IconAlertCircle,
  IconSearch,
  IconWand,
  IconSparkles,
  IconRefresh,
} from '@tabler/icons-react';

const MAX_BROADCAST_LENGTH = 2000;
const IDEAL_MAX_LENGTH = 240;

const messageTemplates = [
  { value: 'arriving', label: 'Bus Arriving', message: 'The bus is arriving in 5 minutes. Please make your way to the pickup point.' },
  { value: 'delayed', label: 'Delay Notice', message: 'We apologize for the delay. The bus will arrive in approximately 15 minutes.' },
  { value: 'departed', label: 'Departed', message: 'The tour has now departed. Thank you for joining us today!' },
  { value: 'weather', label: 'Weather Update', message: 'Due to weather conditions, please dress appropriately for outdoor activities.' },
  { value: 'reminder', label: 'General Reminder', message: 'This is a reminder for all passengers on this tour.' },
  { value: 'custom', label: 'Custom Message', message: '' },
];

const normalizeTourIdForPath = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const isValidFirebaseKeySegment = (value) => {
  return typeof value === 'string' && value.length > 0 && !/[./$#\[\]]/.test(value);
};

function normalizeBroadcastTimestamp(timestamp) {
  return toEpochMsStrict(timestamp);
}

function normalizeBroadcastMessage(tourId, broadcastId, payload = {}) {
  const message = typeof payload.message === 'string' ? payload.message : '';
  const normalizedTimestamp = normalizeBroadcastTimestamp(payload.createdAtMs);

  return {
    id: broadcastId,
    tourId,
    message,
    timestamp: normalizedTimestamp ?? payload.createdAtMs ?? null,
    timestampMs: normalizedTimestamp,
    createdByUid: payload.createdByUid || null,
    source: payload.source || null,
  };
}

function BroadcastHistoryItem({ broadcast }) {
  const timestampMs = normalizeBroadcastTimestamp(broadcast.timestamp);

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
          {formatTimeForDisplay(timestampMs, 'Unknown time')}
        </Text>
      </Group>
      <Text size="sm">{broadcast.message}</Text>
    </Paper>
  );
}

const getMessageTone = (message) => {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      label: 'Start drafting your announcement',
      color: 'gray',
      icon: <IconInfoCircle size={14} />,
      helper: 'Templates are a good baseline for consistent communication.',
    };
  }

  if (trimmed.length < 24) {
    return {
      label: 'Too short for a clear update',
      color: 'yellow',
      icon: <IconAlertCircle size={14} />,
      helper: 'Add context such as place/time so passengers know what to do.',
    };
  }

  if (trimmed.length > IDEAL_MAX_LENGTH) {
    return {
      label: 'Long message: consider tightening',
      color: 'orange',
      icon: <IconAlertCircle size={14} />,
      helper: 'Push notifications perform best when concise and action-oriented.',
    };
  }

  return {
    label: 'Great length for push notifications',
    color: 'green',
    icon: <IconCheck size={14} />,
    helper: 'Clear and concise. Ready for passenger delivery.',
  };
};

export function BroadcastPanel() {
  const [tourId, setTourId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('custom');
  const [tours, setTours] = useState({});
  const [loadingTours, setLoadingTours] = useState(true);
  const [broadcastHistory, setBroadcastHistory] = useState([]);
  const [historyFilter, setHistoryFilter] = useState('');

  useEffect(() => {
    const toursRef = ref(db, 'tours');
    const unsubscribe = onValue(toursRef, (snapshot) => {
      setTours(snapshot.val() || {});
      setLoadingTours(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!tourId) {
      setBroadcastHistory([]);
      return undefined;
    }

    const normalizedTourId = normalizeTourIdForPath(tourId);
    if (!isValidFirebaseKeySegment(normalizedTourId)) {
      setBroadcastHistory([]);
      return undefined;
    }

    const historyQuery = query(
      ref(db, `broadcasts/${normalizedTourId}`),
      orderByChild('createdAtMs'),
      limitToLast(25)
    );

    const unsubscribe = onValue(historyQuery, (snapshot) => {
      const broadcasts = snapshot.val() || {};
      const history = Object.entries(broadcasts)
        .map(([broadcastId, payload]) => normalizeBroadcastMessage(tourId, broadcastId, payload))
        .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));

      setBroadcastHistory(history);
    });

    return () => unsubscribe();
  }, [tourId]);

  const totalTours = Object.keys(tours).length;
  const assignedTours = Object.values(tours).filter((t) => t.driverName && t.driverName !== 'TBA').length;
  const selectedTour = tours[tourId] || null;

  const quality = getMessageTone(message);
  const messageLength = message.trim().length;
  const progress = Math.min(100, Math.round((messageLength / MAX_BROADCAST_LENGTH) * 100));
  const estimatedReadSeconds = Math.max(1, Math.ceil(message.trim().split(/\s+/).filter(Boolean).length / 3));

  const tourOptions = useMemo(() => (
    Object.entries(tours).map(([id, tour]) => ({
      value: id,
      label: `${id} - ${tour.name || tour.driverName || 'TBA'}`,
    }))
  ), [tours]);

  const filteredHistory = useMemo(() => {
    const q = historyFilter.trim().toLowerCase();
    if (!q) return broadcastHistory;
    return broadcastHistory.filter((item) => item.message.toLowerCase().includes(q));
  }, [broadcastHistory, historyFilter]);

  const appendSnippet = (snippet) => {
    setSelectedTemplate('custom');
    setMessage((current) => {
      const base = current.trim();
      return base ? `${base} ${snippet}` : snippet;
    });
  };

  const handleTemplateChange = (value) => {
    setSelectedTemplate(value);
    const template = messageTemplates.find((t) => t.value === value);
    if (template && template.message) {
      setMessage(template.message);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();

    const normalizedTourId = normalizeTourIdForPath(tourId);

    if (!normalizedTourId) {
      notifications.show({ title: 'Tour Required', message: 'Please select a tour to broadcast to', color: 'red' });
      return;
    }

    if (!message.trim()) {
      notifications.show({ title: 'Message Required', message: 'Please enter a message to broadcast', color: 'red' });
      return;
    }

    if (!isValidFirebaseKeySegment(normalizedTourId)) {
      notifications.show({
        title: 'Invalid Tour ID',
        message: 'Selected tour ID cannot be used for broadcast delivery.',
        color: 'red',
      });
      return;
    }

    if (!auth.currentUser?.uid) {
      notifications.show({ title: 'Sign-in Required', message: 'Please sign in again before sending broadcasts.', color: 'red' });
      return;
    }

    if (message.trim().length > MAX_BROADCAST_LENGTH) {
      notifications.show({
        title: 'Message Too Long',
        message: `Broadcast messages must be ${MAX_BROADCAST_LENGTH} characters or fewer.`,
        color: 'red',
      });
      return;
    }

    setLoading(true);

    try {
      const broadcastsRef = ref(db, `broadcasts/${normalizedTourId}`);
      const newBroadcastRef = push(broadcastsRef);

      await set(newBroadcastRef, {
        message: message.trim(),
        createdAtMs: Date.now(),
        createdByUid: auth.currentUser?.uid || null,
        source: 'web_admin',
      });

      notifications.show({
        title: 'Broadcast Sent',
        message: `Announcement sent to tour ${normalizedTourId}`,
        color: 'green',
        icon: <IconCheck size={16} />,
      });

      setMessage('');
      setSelectedTemplate('custom');
    } catch (error) {
      notifications.show({ title: 'Broadcast Failed', message: error.message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box>
      <Group justify="space-between" mb="xl">
        <div>
          <Title order={2}>Broadcast System</Title>
          <Text c="dimmed" size="sm">Premium passenger communication with delivery-safe checks</Text>
        </div>
      </Group>

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
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Recent Broadcasts</Text>
              <Text size="xl" fw={700} c="orange">{broadcastHistory.length}</Text>
            </div>
            <ThemeIcon color="orange" variant="light" size="xl" radius="md">
              <IconSpeakerphone size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group gap="xs" mb="lg">
            <ThemeIcon color="orange" variant="light" size="lg" radius="md">
              <IconBroadcast size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600}>Compose Broadcast</Text>
              <Text size="xs" c="dimmed">Guided composer with live quality signals</Text>
            </div>
          </Group>

          <form onSubmit={handleSend}>
            <Stack gap="md">
              <Select
                label="Target Tour"
                placeholder="Select a tour"
                data={tourOptions}
                value={tourId}
                onChange={setTourId}
                searchable
                clearable
                leftSection={loadingTours ? <Loader size={14} /> : <IconMap size={16} />}
                disabled={loadingTours}
                description="Choose the tour that should receive this push message"
              />

              {selectedTour ? (
                <Paper withBorder p="sm" radius="md" bg="gray.0">
                  <Group justify="space-between">
                    <div>
                      <Text size="xs" c="dimmed">Selected tour</Text>
                      <Text fw={600}>{selectedTour.name || 'Untitled Tour'}</Text>
                      <Text size="xs" c="dimmed">Tour code: {tourId}</Text>
                    </div>
                    <Badge color="blue" variant="light">{selectedTour.driverName || 'Driver unassigned'}</Badge>
                  </Group>
                </Paper>
              ) : null}

              <Select
                label="Message Template"
                placeholder="Choose a template or write custom"
                data={messageTemplates.map((t) => ({ value: t.value, label: t.label }))}
                value={selectedTemplate}
                onChange={handleTemplateChange}
                leftSection={<IconMessage size={16} />}
              />

              <Group gap="xs" wrap="wrap">
                <Tooltip label="Append current time marker">
                  <ActionIcon variant="light" color="blue" onClick={() => appendSnippet(`[${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}]`)}>
                    <IconWand size={16} />
                  </ActionIcon>
                </Tooltip>
                <Button variant="light" size="xs" onClick={() => appendSnippet('Please arrive 10 minutes early.')}>+ arrival note</Button>
                <Button variant="light" size="xs" onClick={() => appendSnippet('Reply in group chat if you need assistance.')}>+ assistance CTA</Button>
              </Group>

              <Textarea
                label="Message"
                placeholder="Enter your announcement message..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                minRows={5}
                maxRows={8}
                description={`${messageLength} characters • ~${estimatedReadSeconds}s read`}
              />

              <Stack gap={6}>
                <Group justify="space-between">
                  <Text size="xs" c="dimmed">Length budget</Text>
                  <Text size="xs" c={messageLength > MAX_BROADCAST_LENGTH ? 'red' : 'dimmed'}>{messageLength}/{MAX_BROADCAST_LENGTH}</Text>
                </Group>
                <Progress
                  value={progress}
                  color={messageLength > MAX_BROADCAST_LENGTH ? 'red' : messageLength > IDEAL_MAX_LENGTH ? 'yellow' : 'green'}
                  size="sm"
                />
              </Stack>

              <Alert icon={quality.icon} color={quality.color} variant="light" title={quality.label}>
                {quality.helper}
              </Alert>

              <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
                This message will be sent to passengers with notifications enabled for this tour.
              </Alert>

              <Button
                type="submit"
                loading={loading}
                fullWidth
                size="lg"
                color="orange"
                leftSection={<IconSend size={18} />}
                disabled={!tourId || !message.trim() || loading || !auth.currentUser?.uid}
              >
                Send Broadcast
              </Button>
            </Stack>
          </form>
        </Card>

        <Stack gap="lg">
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Group gap="xs" mb="sm">
              <ThemeIcon color="violet" variant="light" size="lg" radius="md">
                <IconSparkles size={20} />
              </ThemeIcon>
              <Text fw={600}>Live Preview</Text>
            </Group>
            <Paper withBorder radius="lg" p="md" bg="dark.8">
              <Group justify="space-between" mb="xs">
                <Text size="xs" c="gray.4">LLT App · now</Text>
                <Badge size="xs" variant="light" color="orange">Push</Badge>
              </Group>
              <Text fw={700} c="white">{tourId ? `Tour ${tourId}` : 'Select a tour'}</Text>
              <Text size="sm" c="gray.3" mt="xs">{message.trim() || 'Your broadcast preview appears here...'}</Text>
            </Paper>

            <Divider my="md" />

            <Group justify="space-between">
              <Text size="sm" fw={600}>Delivery Confidence</Text>
              <RingProgress
                size={70}
                thickness={7}
                sections={[{ value: messageLength > MAX_BROADCAST_LENGTH ? 0 : messageLength < 24 ? 35 : messageLength > IDEAL_MAX_LENGTH ? 72 : 100, color: messageLength > MAX_BROADCAST_LENGTH ? 'red' : messageLength < 24 ? 'yellow' : messageLength > IDEAL_MAX_LENGTH ? 'orange' : 'green' }]}
                label={<Text ta="center" size="xs" fw={700}>{messageLength > MAX_BROADCAST_LENGTH ? '0%' : messageLength < 24 ? '35%' : messageLength > IDEAL_MAX_LENGTH ? '72%' : '100%'}</Text>}
              />
            </Group>
          </Card>

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

            <TextInput
              mb="sm"
              leftSection={<IconSearch size={14} />}
              rightSection={historyFilter ? (
                <Tooltip label="Clear filter">
                  <ActionIcon variant="subtle" onClick={() => setHistoryFilter('')}>
                    <IconRefresh size={14} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
              placeholder="Filter by keyword"
              value={historyFilter}
              onChange={(event) => setHistoryFilter(event.currentTarget.value)}
            />

            {filteredHistory.length > 0 ? (
              <ScrollArea h={290}>
                <Stack gap="xs">
                  {filteredHistory.map((broadcast) => (
                    <BroadcastHistoryItem key={broadcast.id} broadcast={broadcast} />
                  ))}
                </Stack>
              </ScrollArea>
            ) : (
              <Paper p="xl" radius="md" bg="gray.0" ta="center">
                <ThemeIcon color="gray" variant="light" size="xl" radius="xl" mb="sm">
                  <IconSpeakerphone size={24} />
                </ThemeIcon>
                <Text c="dimmed" size="sm">No matching broadcasts yet</Text>
              </Paper>
            )}
          </Card>
        </Stack>
      </SimpleGrid>
    </Box>
  );
}
