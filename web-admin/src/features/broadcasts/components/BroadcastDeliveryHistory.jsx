import { ActionIcon, Badge, Card, Group, Paper, ScrollArea, Stack, Text, TextInput, ThemeIcon, Tooltip } from '@mantine/core';
import { IconHistory, IconRefresh, IconSearch, IconSpeakerphone } from '@tabler/icons-react';
import BroadcastHistoryItem from './BroadcastHistoryItem';

export default function BroadcastDeliveryHistory({ broadcasts, filter, onFilterChange, onClearFilter, onRequeue, requeueingJobId }) {
  const visible = broadcasts.filter((broadcast) => broadcast.message.toLowerCase().includes(filter.trim().toLowerCase()));
  return <Card shadow="sm" padding="lg" radius="md" withBorder>
    <Group justify="space-between" mb="md"><Group gap="xs"><ThemeIcon color="gray" variant="light" size="lg" radius="md"><IconHistory size={20} /></ThemeIcon><Text fw={600}>Delivery history</Text></Group><Badge variant="light" color="gray">{visible.length}</Badge></Group>
    <TextInput mb="sm" leftSection={<IconSearch size={14} />} rightSection={filter ? <Tooltip label="Clear filter"><ActionIcon variant="subtle" onClick={onClearFilter}><IconRefresh size={14} /></ActionIcon></Tooltip> : null} placeholder="Filter by keyword" value={filter} onChange={(event) => onFilterChange(event.currentTarget.value)} />
    {visible.length > 0 ? <ScrollArea h={290}><Stack gap="xs">{visible.map((broadcast) => <BroadcastHistoryItem key={broadcast.id} broadcast={broadcast} onRequeue={onRequeue} requeueing={requeueingJobId === broadcast.deliveryJobId} />)}</Stack></ScrollArea> : <Paper p="xl" radius="md" bg="gray.0" ta="center"><ThemeIcon color="gray" variant="light" size="xl" radius="xl" mb="sm"><IconSpeakerphone size={24} /></ThemeIcon><Text c="dimmed" size="sm">No matching broadcasts yet</Text></Paper>}
  </Card>;
}
