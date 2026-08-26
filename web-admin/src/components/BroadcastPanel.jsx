import { useMemo, useState, useEffect, useRef } from 'react';
import { getCurrentAdminUser } from '../shared/runtime/adminRuntime';
import {
  createServerTestNotification,
  previewNotificationAudience,
  queueBroadcast,
  requeueNotificationJob,
  subscribeToBroadcastHistory,
  subscribeToBroadcastTours,
} from '../services/broadcastRepository';
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
  SegmentedControl,
  Alert,
  Loader,
  Progress,
  Divider,
  RingProgress,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconSpeakerphone,
  IconSend,
  IconMap,
  IconUsers,
  IconCheck,
  IconMessage,
  IconBroadcast,
  IconInfoCircle,
  IconAlertCircle,
  IconWand,
  IconSparkles,
} from '@tabler/icons-react';
import {
  TOUR_NOTIFICATION_CATEGORY_OPTIONS,
  getTourNotificationCategoryLabel,
} from '../utils/notificationCategories';

import {
  EMPTY_BROADCAST_HISTORY,
  IDEAL_MAX_LENGTH,
  MAX_BROADCAST_LENGTH,
  getMessageTone,
  isValidFirebaseKeySegment,
  messageTemplates,
  normalizeBroadcastMessage,
  normalizeTourIdForPath,
} from '../features/broadcasts/components/broadcastPresentation';
import NotificationAudiencePreview from '../features/broadcasts/components/NotificationAudiencePreview';
import BroadcastDeliveryHistory from '../features/broadcasts/components/BroadcastDeliveryHistory';
import BroadcastConfirmationModal from '../features/broadcasts/components/BroadcastConfirmationModal';
export function BroadcastPanel() {
  const [tourId, setTourId] = useState('');
  const [targetMode, setTargetMode] = useState('tour');
  const [categoryKey, setCategoryKey] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('custom');
  const [tours, setTours] = useState({});
  const [loadingTours, setLoadingTours] = useState(true);
  const [broadcastHistoryState, setBroadcastHistoryState] = useState({ rootPath: '', items: [] });
  const [historyFilter, setHistoryFilter] = useState('');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [audiencePreview, setAudiencePreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [serverTestLoading, setServerTestLoading] = useState(false);
  const [requeueingJobId, setRequeueingJobId] = useState('');
  const sendInFlightRef = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeToBroadcastTours({
      onData: (nextTours) => {
        setTours(nextTours);
        setLoadingTours(false);
      },
      onError: (error) => {
        setLoadingTours(false);
        notifications.show({ title: 'Tours unavailable', message: error?.message || 'Could not load broadcast targets.', color: 'red' });
      },
    });
    return () => unsubscribe();
  }, []);

  const historyTargetId = targetMode === 'category'
    ? categoryKey
    : normalizeTourIdForPath(tourId);
  const historyRootPath = historyTargetId && isValidFirebaseKeySegment(historyTargetId)
    ? `${targetMode === 'category' ? 'category_broadcasts' : 'broadcasts'}/${historyTargetId}`
    : '';
  const broadcastHistory = broadcastHistoryState.rootPath === historyRootPath
    ? broadcastHistoryState.items
    : EMPTY_BROADCAST_HISTORY;

  useEffect(() => {
    if (!historyRootPath) return undefined;

    const unsubscribe = subscribeToBroadcastHistory({
      rootPath: historyRootPath,
      onData: (broadcasts) => {
        const history = Object.entries(broadcasts)
          .map(([broadcastId, payload]) => normalizeBroadcastMessage(historyTargetId, broadcastId, payload, targetMode))
          .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));

        setBroadcastHistoryState({ rootPath: historyRootPath, items: history });
      },
      onError: (error) => notifications.show({ title: 'History unavailable', message: error?.message || 'Could not load broadcast history.', color: 'red' }),
    });

    return () => unsubscribe();
  }, [historyRootPath, historyTargetId, targetMode]);

  const totalTours = Object.keys(tours).length;
  const assignedTours = Object.values(tours).filter((t) => t.driverName && t.driverName !== 'TBA').length;
  const selectedTour = tours[tourId] || null;
  const isCategoryMode = targetMode === 'category';
  const selectedCategoryLabel = categoryKey ? getTourNotificationCategoryLabel(categoryKey) : '';
  const selectedTargetLabel = isCategoryMode
    ? selectedCategoryLabel
    : tourId ? `Tour ${tourId}` : '';
  const hasTarget = isCategoryMode ? Boolean(categoryKey) : Boolean(tourId);

  const previewRequest = useMemo(() => {
    const selectedId = isCategoryMode ? categoryKey.trim() : normalizeTourIdForPath(tourId);
    if (!selectedId || !isValidFirebaseKeySegment(selectedId)) return null;
    return isCategoryMode ? { categoryKey: selectedId } : { tourId: selectedId };
  }, [categoryKey, isCategoryMode, tourId]);

  const refreshAudiencePreview = async () => {
    if (!previewRequest) return;
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const result = await previewNotificationAudience(previewRequest);
      setAudiencePreview(result.preview || null);
    } catch (error) {
      setAudiencePreview(null);
      setPreviewError(error.message || 'Could not calculate the current eligible audience.');
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!previewRequest) return undefined;
    const timer = setTimeout(() => {
      setPreviewLoading(true);
      setAudiencePreview(null);
      setPreviewError('');
      previewNotificationAudience(previewRequest)
      .then((result) => setAudiencePreview(result.preview || null))
      .catch((error) => setPreviewError(error.message || 'Could not calculate the current eligible audience.'))
      .finally(() => setPreviewLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [previewRequest]); // The request is server-authoritative; refresh after every target change.

  const quality = getMessageTone(message);
  const QualityIcon = quality.icon === 'check'
    ? IconCheck
    : quality.icon === 'alert' ? IconAlertCircle : IconInfoCircle;
  const messageLength = message.trim().length;
  const progress = Math.min(100, Math.round((messageLength / MAX_BROADCAST_LENGTH) * 100));
  const estimatedReadSeconds = Math.max(1, Math.ceil(message.trim().split(/\s+/).filter(Boolean).length / 3));

  const tourOptions = useMemo(() => (
    Object.entries(tours).map(([id, tour]) => ({
      value: id,
      label: `${id} - ${tour.name || tour.driverName || 'TBA'}`,
    }))
  ), [tours]);

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

  const handleSend = async (e, confirmed = false) => {
    e?.preventDefault?.();

    const normalizedTourId = normalizeTourIdForPath(tourId);
    const normalizedCategoryKey = typeof categoryKey === 'string' ? categoryKey.trim() : '';
    const targetId = isCategoryMode ? normalizedCategoryKey : normalizedTourId;
    const targetLabel = isCategoryMode
      ? getTourNotificationCategoryLabel(normalizedCategoryKey)
      : normalizedTourId;

    if (!targetId) {
      notifications.show({
        title: isCategoryMode ? 'Tour Type Required' : 'Tour Required',
        message: isCategoryMode
          ? 'Please select a tour type to broadcast to'
          : 'Please select a tour to broadcast to',
        color: 'red',
      });
      return;
    }

    if (!message.trim()) {
      notifications.show({ title: 'Message Required', message: 'Please enter a message to broadcast', color: 'red' });
      return;
    }

    if (!isValidFirebaseKeySegment(targetId)) {
      notifications.show({
        title: isCategoryMode ? 'Invalid Tour Type' : 'Invalid Tour ID',
        message: isCategoryMode
          ? 'Selected tour type cannot be used for broadcast delivery.'
          : 'Selected tour ID cannot be used for broadcast delivery.',
        color: 'red',
      });
      return;
    }

    if (!getCurrentAdminUser()?.uid) {
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

    if (!confirmed) {
      if (!audiencePreview || previewLoading) {
        notifications.show({ title: 'Audience check required', message: 'Wait for the current server audience check before confirming this broadcast.', color: 'yellow' });
        return;
      }
      setConfirmationOpen(true);
      return;
    }

    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    setLoading(true);

    try {
      const rootPath = isCategoryMode
        ? `category_broadcasts/${targetId}`
        : `broadcasts/${targetId}`;
      const broadcastPayload = {
        message: message.trim(),
        createdAtMs: Date.now(),
        source: 'web_admin',
        deliveryStatus: 'queued',
        deliveryUpdatedAtMs: Date.now(),
      };

      if (isCategoryMode) {
        broadcastPayload.categoryKey = targetId;
        broadcastPayload.categoryLabel = targetLabel;
      }

      await queueBroadcast({ rootPath, payload: broadcastPayload });

      notifications.show({
        title: 'Broadcast Queued',
        message: isCategoryMode
          ? `Delivery is being processed for ${targetLabel} subscribers`
          : `Delivery is being processed for tour ${targetId}`,
        color: 'blue',
        icon: <IconCheck size={16} />,
      });

      setMessage('');
      setSelectedTemplate('custom');
    } catch (error) {
      notifications.show({ title: 'Broadcast Failed', message: error.message, color: 'red' });
    } finally {
      sendInFlightRef.current = false;
      setLoading(false);
      setConfirmationOpen(false);
    }
  };

  const handleServerTest = async () => {
    setServerTestLoading(true);
    try {
      const result = await createServerTestNotification(`web-admin-${Date.now()}`);
      notifications.show({ title: 'Server test queued', message: `Job ${result.jobId} is running through the Expo ticket and receipt pipeline for this administrator device only.`, color: 'blue' });
    } catch (error) {
      notifications.show({ title: 'Server test unavailable', message: error.message, color: 'red' });
    } finally {
      setServerTestLoading(false);
    }
  };

  const handleRequeue = async (jobId) => {
    setRequeueingJobId(jobId);
    try {
      await requeueNotificationJob(jobId);
      notifications.show({ title: 'Requeue requested', message: 'The remaining eligible recipients will be retried using the existing delivery job.', color: 'blue' });
    } catch (error) {
      notifications.show({ title: 'Cannot requeue job', message: error.message, color: 'red' });
    } finally {
      setRequeueingJobId('');
    }
  };

  return (
    <Box>
      <Group justify="space-between" mb="xl">
        <div>
          <Title order={2}>Broadcast System</Title>
          <Text c="dimmed" size="sm">Server-authoritative audience checks, durable delivery jobs and receipt reporting</Text>
        </div>
        <Button variant="light" leftSection={<IconSend size={16} />} loading={serverTestLoading} onClick={handleServerTest} disabled={!getCurrentAdminUser()?.uid}>
          Test my current device
        </Button>
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
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Assigned Tours</Text>
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
              <Box>
                <Text size="sm" fw={600} mb={6}>Broadcast Target</Text>
                <SegmentedControl
                  fullWidth
                  value={targetMode}
                  onChange={setTargetMode}
                  data={[
                    { value: 'tour', label: 'Specific tour' },
                    { value: 'category', label: 'Tour type' },
                  ]}
                />
              </Box>

              {isCategoryMode ? (
                <Select
                  label="Target Tour Type"
                  placeholder="Select a tour type"
                  data={TOUR_NOTIFICATION_CATEGORY_OPTIONS}
                  value={categoryKey}
                  onChange={setCategoryKey}
                  searchable
                  limit={50}
                  clearable
                  leftSection={<IconSparkles size={16} />}
                  description="Send to clients who opted in to this future-tour category"
                />
              ) : (
                <Select
                  label="Target Tour"
                  placeholder="Select a tour"
                  data={tourOptions}
                  value={tourId}
                  onChange={setTourId}
                  searchable
                  limit={50}
                  clearable
                  leftSection={loadingTours ? <Loader size={14} /> : <IconMap size={16} />}
                  disabled={loadingTours}
                  description="Choose the tour that should receive this push message"
                />
              )}

              {!isCategoryMode && selectedTour ? (
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

              {isCategoryMode && categoryKey ? (
                <Paper withBorder p="sm" radius="md" bg="blue.0">
                  <Group justify="space-between">
                    <div>
                      <Text size="xs" c="dimmed">Selected tour type</Text>
                      <Text fw={600}>{selectedCategoryLabel}</Text>
                    </div>
                    <Badge color="blue" variant="light">Opt-in audience</Badge>
                  </Group>
                </Paper>
              ) : null}

              {previewRequest ? (
                <NotificationAudiencePreview preview={audiencePreview} loading={previewLoading} error={previewError} onRefresh={refreshAudiencePreview} />
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

              <Alert icon={<QualityIcon size={14} />} color={quality.color} variant="light" title={quality.label}>
                {quality.helper}
              </Alert>

              <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
                {isCategoryMode
                  ? 'The delivery result will appear in Recent Broadcasts. “Push accepted” means Expo accepted the notification request, not that every device displayed it.'
                  : 'The delivery result will appear in Recent Broadcasts. Only eligible tour participants with a valid push token are counted.'}
              </Alert>

              <Button
                type="submit"
                loading={loading}
                fullWidth
                size="lg"
                color={isCategoryMode ? 'blue' : 'orange'}
                leftSection={<IconSend size={18} />}
                disabled={!hasTarget || !message.trim() || loading || previewLoading || !audiencePreview || !getCurrentAdminUser()?.uid}
              >
                {isCategoryMode ? 'Send Tour Type Broadcast' : 'Send Broadcast'}
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
                <Badge size="xs" variant="light" color={isCategoryMode ? 'blue' : 'orange'}>
                  {isCategoryMode ? 'Tour type' : 'Push'}
                </Badge>
              </Group>
              <Text fw={700} c="white">
                {selectedTargetLabel || (isCategoryMode ? 'Select a tour type' : 'Select a tour')}
              </Text>
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

          <BroadcastDeliveryHistory broadcasts={broadcastHistory} filter={historyFilter} onFilterChange={setHistoryFilter} onClearFilter={() => setHistoryFilter('')} onRequeue={handleRequeue} requeueingJobId={requeueingJobId} />
        </Stack>
      </SimpleGrid>

      <BroadcastConfirmationModal opened={confirmationOpen} onClose={() => !loading && setConfirmationOpen(false)} loading={loading} categoryMode={isCategoryMode} targetLabel={selectedTargetLabel} message={message.trim()} preview={audiencePreview} onConfirm={() => handleSend(null, true)} />
    </Box>
  );
}
