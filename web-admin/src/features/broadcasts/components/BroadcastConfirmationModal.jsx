import { Alert, Button, Group, Modal, Paper, Stack, Text } from '@mantine/core';
import { IconAlertCircle, IconSend } from '@tabler/icons-react';

export default function BroadcastConfirmationModal({ opened, onClose, loading, categoryMode, targetLabel, message, preview, onConfirm }) {
  return <Modal opened={opened} onClose={onClose} title="Confirm broadcast delivery" centered closeOnClickOutside={!loading} closeOnEscape={!loading}>
    <Stack gap="md"><Alert color={categoryMode ? 'blue' : 'orange'} icon={<IconAlertCircle size={16} />}>This sends an external notification to the eligible audience for <strong>{targetLabel}</strong>.</Alert><Paper withBorder p="md" radius="md"><Text size="sm">{message}</Text></Paper>{preview ? <Paper withBorder p="sm" radius="md" bg="gray.0"><Text size="sm" fw={600}>{preview.eligible} currently eligible recipients</Text><Text size="xs" c="dimmed">{preview.skipped} will be skipped. Eligibility is checked again while the delivery job runs; ticket acceptance and provider receipt are reported separately.</Text></Paper> : null}<Group justify="flex-end"><Button variant="light" onClick={onClose} disabled={loading}>Cancel</Button><Button color={categoryMode ? 'blue' : 'orange'} leftSection={<IconSend size={16} />} loading={loading} onClick={onConfirm}>Confirm and send</Button></Group></Stack>
  </Modal>;
}
