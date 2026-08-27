import { Button, Group, Loader, Paper, Text } from '@mantine/core';

export default function NotificationAudiencePreview({ preview, loading, error, onRefresh }) {
  return (
    <Paper withBorder p="sm" radius="md" bg="gray.0">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text size="xs" c="dimmed">Current server audience</Text>
          {loading ? <Group gap="xs"><Loader size={14} /><Text size="sm">Checking eligibility…</Text></Group> : preview ? <Text fw={600}>{preview.eligible} eligible of {preview.audience} candidates</Text> : <Text c="red" size="sm">Audience check unavailable</Text>}
          {preview ? <Text size="xs" c="dimmed">{preview.skipped} skipped · estimated {preview.estimatedPages} delivery page{preview.estimatedPages === 1 ? '' : 's'}</Text> : null}
          {error ? <Text size="xs" c="red">{error}</Text> : null}
        </div>
        <Button size="compact-xs" variant="subtle" onClick={onRefresh} loading={loading}>Refresh</Button>
      </Group>
    </Paper>
  );
}
