import { Badge, Box, Card, Center, Group, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconActivity, IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { SAFETY_STATUS } from '../../../services/dashboardService';
import { OPS_ALERT_STATUS } from '../../../services/opsAlertService';
import { formatTimeForDisplay } from '../../../utils/dateUtils';
const OPS_SEVERITY_COLOR = {
  critical: 'red',
  error: 'orange',
  warning: 'yellow',
  info: 'blue'
};
const OPS_STATUS_COLOR = {
  [OPS_ALERT_STATUS.OPEN]: 'red',
  [OPS_ALERT_STATUS.ACKNOWLEDGED]: 'yellow',
  [OPS_ALERT_STATUS.RESOLVED]: 'green'
};
const SAFETY_SEVERITY_COLOR = {
  critical: 'red',
  high: 'orange',
  medium: 'yellow',
  low: 'green'
};
const SAFETY_STATUS_COLOR = {
  [SAFETY_STATUS.PENDING]: 'red',
  [SAFETY_STATUS.ACKNOWLEDGED]: 'yellow',
  [SAFETY_STATUS.IN_PROGRESS]: 'blue',
  [SAFETY_STATUS.ESCALATED]: 'orange',
  [SAFETY_STATUS.RESOLVED]: 'green'
};
const BRANCH_LABELS = {
  drivers: {
    label: 'Drivers',
    description: 'Driver roster and assignment helpers'
  },
  tours: {
    label: 'Tours',
    description: 'Tour records, capacity, safety branches'
  },
  tourManifests: {
    label: 'Manifests',
    description: 'Assigned drivers and passenger manifests'
  },
  globalSafetyAlerts: {
    label: 'Safety',
    description: 'Global SOS and critical safety alerts'
  },
  broadcasts: {
    label: 'Broadcasts',
    description: 'Admin passenger announcements'
  },
  opsAlerts: {
    label: 'App errors',
    description: 'Curated mobile app/device failures'
  }
};
export function MetricCard({
  title,
  value,
  icon: _Icon,
  color,
  subtitle,
  detail
}) {
  return <Card shadow="sm" padding="md" radius="md" withBorder>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{
        minWidth: 0
      }}>
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            {title}
          </Text>
          <Title order={2}>{value}</Title>
          <Text size="xs" c="dimmed">
            {subtitle}
          </Text>
          {detail ? <Text size="xs" c="dimmed">
              {detail}
            </Text> : null}
        </Stack>
        <ThemeIcon color={color} variant="light" radius="md" size={44}>
          <_Icon size={21} stroke={1.7} />
        </ThemeIcon>
      </Group>
    </Card>;
}
export function OpsAlertBadge({
  value,
  kind = 'severity'
}) {
  const color = kind === 'status' ? OPS_STATUS_COLOR[value] || 'gray' : OPS_SEVERITY_COLOR[value] || 'gray';
  return <Badge size="sm" color={color} variant={kind === 'status' ? 'light' : 'filled'}>
      {value || 'unknown'}
    </Badge>;
}
export function SafetyBadge({
  value,
  kind = 'severity'
}) {
  const color = kind === 'status' ? SAFETY_STATUS_COLOR[value] || 'gray' : SAFETY_SEVERITY_COLOR[value] || 'gray';
  return <Badge size="sm" color={color} variant={kind === 'status' ? 'light' : 'filled'}>
      {String(value || 'unknown').replace(/_/g, ' ')}
    </Badge>;
}
export function BranchHealthRow({
  branchKey,
  loading,
  error,
  syncedAt
}) {
  const meta = BRANCH_LABELS[branchKey];
  const color = error ? 'red' : loading ? 'yellow' : 'green';
  const label = error ? 'Degraded' : loading ? 'Loading' : 'Loaded';
  return <Paper p="sm" radius="md" withBorder>
      <Group wrap="nowrap" align="center">
        <ThemeIcon color={color} variant="light" size="md" radius="md">
          {error ? <IconAlertTriangle size={15} /> : <IconActivity size={15} />}
        </ThemeIcon>
        <Box style={{
        flex: 1,
        minWidth: 0
      }}>
          <Text size="sm" fw={600}>{meta.label}</Text>
          <Text size="xs" c="dimmed" truncate="end">{meta.description}</Text>
          <Text size="xs" c="dimmed">
            Last update: {formatTimeForDisplay(syncedAt, 'awaiting data')}
          </Text>
        </Box>
        <Badge size="sm" color={color} variant="light">{label}</Badge>
      </Group>
    </Paper>;
}
export function PanelHeader({
  icon: _Icon,
  title,
  description,
  right
}) {
  return <Group justify="space-between" align="flex-start" mb="md" gap="md">
      <Group gap="sm" align="flex-start">
        <ThemeIcon color="brand" variant="light" size="lg" radius="md">
          <_Icon size={18} />
        </ThemeIcon>
        <Box>
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed">{description}</Text>
        </Box>
      </Group>
      {right}
    </Group>;
}
export function EmptyState({
  icon: _Icon = IconCircleCheck,
  title,
  description,
  color = 'green'
}) {
  return <Center py="xl">
      <Stack align="center" gap="xs">
        <ThemeIcon color={color} variant="light" size="lg" radius="xl">
          <_Icon size={18} />
        </ThemeIcon>
        <Text size="sm" fw={600}>{title}</Text>
        {description ? <Text size="xs" c="dimmed" ta="center" maw={360}>
            {description}
          </Text> : null}
      </Stack>
    </Center>;
}
