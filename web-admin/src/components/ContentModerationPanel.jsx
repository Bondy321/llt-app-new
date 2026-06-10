import { useEffect, useMemo, useState } from 'react';
import { notifications } from '@mantine/notifications';
import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconEye,
  IconFlag,
  IconPhoto,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { db } from '../firebase';
import {
  CONTENT_REPORT_STATUS,
  CONTENT_REPORT_STATUS_OPTIONS,
  buildContentReportStats,
  fetchContentReports,
  filterContentReports,
  removeReportedContent,
  subscribeToContentReports,
  updateContentReportStatus,
} from '../services/contentModerationService';
import {
  logFirebaseError,
  startFirebaseDebugTimer,
  summarizeDatabaseInstance,
} from '../services/firebaseDebug';
import { formatDateTimeForDisplay } from '../utils/dateUtils';

const REPORT_STATUS_COLOR = {
  [CONTENT_REPORT_STATUS.OPEN]: 'red',
  [CONTENT_REPORT_STATUS.REVIEWING]: 'yellow',
  [CONTENT_REPORT_STATUS.ACTIONED]: 'green',
  [CONTENT_REPORT_STATUS.DISMISSED]: 'gray',
};

const CONTENT_TYPE_LABEL = {
  chat_message: 'Chat',
  group_photo: 'Photo',
};

const formatReason = (reason) => (
  String(reason || 'other')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
);

export function ContentModerationPanel() {
  const [reports, setReports] = useState([]);
  const [statusFilter, setStatusFilter] = useState('active');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [mutatingReportId, setMutatingReportId] = useState(null);

  useEffect(() => {
    const unsubscribe = subscribeToContentReports(
      db,
      { limit: 120 },
      (nextReports) => {
        setReports(nextReports);
        setLoading(false);
        setError(null);
      },
      (nextError) => {
        logFirebaseError('content-moderation:subscribe:error', nextError, {
          database: summarizeDatabaseInstance(db),
        });
        setError(nextError);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, []);

  const stats = useMemo(() => buildContentReportStats(reports), [reports]);
  const visibleReports = useMemo(
    () => filterContentReports(reports, statusFilter),
    [reports, statusFilter],
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    const timer = startFirebaseDebugTimer('content-moderation:refresh', {
      database: summarizeDatabaseInstance(db),
    });

    try {
      const nextReports = await fetchContentReports(db, { limit: 120 });
      setReports(nextReports);
      setError(null);
      timer.success({ reportCount: nextReports.length });
      notifications.show({
        title: 'Reports refreshed',
        message: 'Moderation reports were reloaded from Firebase.',
        color: 'green',
      });
    } catch (refreshError) {
      timer.failure(refreshError);
      setError(refreshError);
      notifications.show({
        title: 'Refresh failed',
        message: 'Unable to reload content reports.',
        color: 'red',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleStatusChange = async (report, status) => {
    setMutatingReportId(report.id);
    try {
      await updateContentReportStatus(db, report.id, status);
      notifications.show({
        title: 'Report updated',
        message: `Report marked ${status}.`,
        color: status === CONTENT_REPORT_STATUS.DISMISSED ? 'gray' : 'green',
      });
    } catch {
      notifications.show({
        title: 'Update failed',
        message: 'Unable to update report status.',
        color: 'red',
      });
    } finally {
      setMutatingReportId(null);
    }
  };

  const handleRemoveContent = async (report) => {
    setMutatingReportId(report.id);
    try {
      const result = await removeReportedContent(db, report);
      notifications.show({
        title: 'Content removed',
        message: `Removed ${result.contentPath}.`,
        color: 'green',
      });
    } catch (removeError) {
      notifications.show({
        title: 'Removal failed',
        message: removeError?.message || 'Unable to remove reported content.',
        color: 'red',
      });
    } finally {
      setMutatingReportId(null);
    }
  };

  if (loading) {
    return (
      <Center style={{ minHeight: 420 }}>
        <Stack align="center" gap="md">
          <Loader size="lg" color="brand" />
          <Text c="dimmed">Loading content reports...</Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" p="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Stack gap={6}>
            <Group gap="xs">
              <ThemeIcon color="red" variant="light" size="md" radius="md">
                <IconFlag size={16} />
              </ThemeIcon>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                Moderation queue
              </Text>
            </Group>
            <Title order={2}>Content Reports</Title>
            <Text c="dimmed" maw={760}>
              Review reported group chat messages and group album photos, then remove, action, or dismiss them.
            </Text>
            <Group gap="sm" mt="xs">
              <Badge color={stats.activeCount > 0 ? 'red' : 'green'} variant="light">
                {stats.activeCount} active
              </Badge>
              <Badge color="gray" variant="outline">
                {stats.totalCount} recent reports
              </Badge>
            </Group>
          </Stack>

          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            loading={refreshing}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        </Group>
      </Card>

      <Card withBorder radius="md" p="md">
        <Group justify="space-between" align="flex-end" mb="md" wrap="wrap">
          <Select
            label="Status"
            data={CONTENT_REPORT_STATUS_OPTIONS}
            value={statusFilter}
            onChange={(value) => setStatusFilter(value || 'active')}
            w={200}
            allowDeselect={false}
          />
          <Text size="xs" c="dimmed">
            Showing {visibleReports.length} of {reports.length} recent reports
          </Text>
        </Group>

        {error ? (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="md">
            Content reports are unavailable. Check admin access and Firebase rules deployment.
          </Alert>
        ) : null}

        {visibleReports.length > 0 ? (
          <ScrollArea type="auto">
            <Table highlightOnHover verticalSpacing="sm" miw={980}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Reason</Table.Th>
                  <Table.Th>Tour</Table.Th>
                  <Table.Th>Content</Table.Th>
                  <Table.Th>Reporter</Table.Th>
                  <Table.Th>Reported</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visibleReports.map((report) => {
                  const mutating = mutatingReportId === report.id;
                  return (
                    <Table.Tr key={report.id}>
                      <Table.Td>
                        <Badge color={REPORT_STATUS_COLOR[report.status] || 'gray'} variant="light">
                          {report.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          {report.contentType === 'group_photo' ? <IconPhoto size={16} /> : <IconFlag size={16} />}
                          <Text size="sm">{CONTENT_TYPE_LABEL[report.contentType] || report.contentType}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{formatReason(report.reason)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={600}>{report.tourId || '-'}</Text>
                      </Table.Td>
                      <Table.Td maw={300}>
                        <Text size="sm" fw={600} lineClamp={1}>
                          {report.contentOwnerName || 'Participant'}
                        </Text>
                        <Text size="xs" c="dimmed" lineClamp={3}>
                          {report.contentPreview || report.sourcePath || report.contentId}
                        </Text>
                      </Table.Td>
                      <Table.Td maw={180}>
                        <Text size="sm" lineClamp={1}>{report.reporterName || 'Reporter'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {formatDateTimeForDisplay(report.createdAtMs, '-')}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          {report.status === CONTENT_REPORT_STATUS.OPEN && (
                            <Button
                              size="xs"
                              variant="light"
                              leftSection={<IconEye size={14} />}
                              loading={mutating}
                              onClick={() => handleStatusChange(report, CONTENT_REPORT_STATUS.REVIEWING)}
                            >
                              Review
                            </Button>
                          )}
                          {(report.status === CONTENT_REPORT_STATUS.OPEN || report.status === CONTENT_REPORT_STATUS.REVIEWING) && (
                            <Button
                              size="xs"
                              color="red"
                              variant="light"
                              leftSection={<IconTrash size={14} />}
                              loading={mutating}
                              onClick={() => handleRemoveContent(report)}
                            >
                              Remove
                            </Button>
                          )}
                          {report.status !== CONTENT_REPORT_STATUS.DISMISSED && report.status !== CONTENT_REPORT_STATUS.ACTIONED && (
                            <Button
                              size="xs"
                              color="gray"
                              variant="subtle"
                              leftSection={<IconCheck size={14} />}
                              loading={mutating}
                              onClick={() => handleStatusChange(report, CONTENT_REPORT_STATUS.DISMISSED)}
                            >
                              Dismiss
                            </Button>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        ) : (
          <Center py="xl">
            <Stack align="center" gap="xs">
              <ThemeIcon color="green" variant="light" size="lg" radius="xl">
                <IconCheck size={20} />
              </ThemeIcon>
              <Text fw={600}>No reports in this view</Text>
              <Text size="sm" c="dimmed">Change the status filter to see resolved or dismissed reports.</Text>
            </Stack>
          </Center>
        )}
      </Card>
    </Stack>
  );
}

export default ContentModerationPanel;
