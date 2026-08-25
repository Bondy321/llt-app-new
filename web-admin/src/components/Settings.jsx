import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  Paper,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconCheck,
  IconDatabase,
  IconInfoCircle,
  IconKey,
  IconLock,
  IconMail,
  IconShield,
  IconUser,
} from '@tabler/icons-react';
import { changeCurrentAccountPassword, getCurrentAccountUser } from '../services/accountSecurityService';

/* global __APP_VERSION__ */

function SettingsSection({ title, description, icon, color, children }) {
  const SectionIcon = icon;
  return (
    <Card shadow="sm" padding="lg" radius="md" withBorder>
      <Group gap="md" mb="lg">
        <ThemeIcon color={color} variant="light" size="lg" radius="md">
          <SectionIcon size={20} />
        </ThemeIcon>
        <div>
          <Text fw={600}>{title}</Text>
          <Text size="xs" c="dimmed">{description}</Text>
        </div>
      </Group>
      {children}
    </Card>
  );
}

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'development';

export default function Settings() {
  const user = getCurrentAccountUser();
  const [passwordModalOpened, { open: openPasswordModal, close: closePasswordModal }] = useDisclosure(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const clearPasswordForm = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const closePassword = () => {
    clearPasswordForm();
    closePasswordModal();
  };

  const handlePasswordChange = async (event) => {
    event.preventDefault();
    if (!user?.email) {
      notifications.show({ title: 'Session expired', message: 'Sign in again and retry.', color: 'red' });
      return;
    }
    if (newPassword !== confirmPassword) {
      notifications.show({ title: 'Password mismatch', message: 'New password and confirmation do not match.', color: 'red' });
      return;
    }
    if (newPassword.length < 8) {
      notifications.show({ title: 'Weak password', message: 'Password must be at least 8 characters long.', color: 'red' });
      return;
    }

    setChangingPassword(true);
    try {
      await changeCurrentAccountPassword({ currentPassword, newPassword });
      notifications.show({ title: 'Password updated', message: 'Your password has been changed successfully.', color: 'green' });
      closePassword();
    } catch (error) {
      const invalidCredential = ['auth/wrong-password', 'auth/invalid-credential'].includes(error?.code);
      notifications.show({
        title: 'Password not changed',
        message: invalidCredential
          ? 'Your current password is incorrect.'
          : error?.code === 'auth/too-many-requests'
            ? 'Too many attempts. Wait a moment and try again.'
            : 'Firebase could not change the password. Retry after checking your connection.',
        color: 'red',
      });
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <Box>
      <Group justify="space-between" mb="xl">
        <div>
          <Title order={2}>Settings</Title>
          <Text c="dimmed" size="sm">Account security and verified deployment information</Text>
        </div>
      </Group>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <SettingsSection title="Profile" description="Your Firebase admin account" icon={IconUser} color="brand">
          <Stack gap="md">
            <Paper p="md" radius="md" bg="gray.0">
              <Group gap="md">
                <Avatar size="lg" radius="xl" color="brand">{user?.email?.charAt(0).toUpperCase() || '?'}</Avatar>
                <div>
                  <Text fw={500}>{user?.email?.split('@')[0] || 'Admin'}</Text>
                  <Text size="sm" c="dimmed">{user?.email || 'No email available'}</Text>
                </div>
                <Badge ml="auto" variant="light" color="green">Admin</Badge>
              </Group>
            </Paper>
            <TextInput label="Email address" value={user?.email || ''} disabled leftSection={<IconMail size={16} />} />
            <TextInput label="Account ID" value={user?.uid || ''} disabled leftSection={<IconUser size={16} />} />
          </Stack>
        </SettingsSection>

        <SettingsSection title="Security" description="Password and current session" icon={IconShield} color="red">
          <Stack gap="md">
            <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
              Use a strong, unique password. Firebase requires your current password before accepting a change.
            </Alert>
            <Paper p="md" radius="md" withBorder>
              <Group justify="space-between">
                <Group gap="md">
                  <ThemeIcon color="gray" variant="light" size="lg" radius="md"><IconKey size={18} /></ThemeIcon>
                  <div><Text fw={500}>Password</Text><Text size="xs" c="dimmed">Managed by Firebase Authentication</Text></div>
                </Group>
                <Button variant="light" onClick={openPasswordModal}>Change</Button>
              </Group>
            </Paper>
            <Paper p="md" radius="md" withBorder>
              <Group justify="space-between">
                <Group gap="md">
                  <ThemeIcon color="green" variant="light" size="lg" radius="md"><IconLock size={18} /></ThemeIcon>
                  <div><Text fw={500}>Session</Text><Text size="xs" c="dimmed">Authenticated with Firebase</Text></div>
                </Group>
                <Badge color="green" variant="filled">Active</Badge>
              </Group>
            </Paper>
          </Stack>
        </SettingsSection>

        <SettingsSection title="System information" description="Build and backend details" icon={IconDatabase} color="green">
          <Stack gap="md">
            <Paper p="md" radius="md" bg="gray.0">
              <Stack gap="xs">
                <Group justify="space-between"><Text size="sm" c="dimmed">Web admin version</Text><Badge variant="light">{APP_VERSION}</Badge></Group>
                <Group justify="space-between"><Text size="sm" c="dimmed">Build mode</Text><Badge variant="light" color={import.meta.env.PROD ? 'green' : 'yellow'}>{import.meta.env.MODE}</Badge></Group>
                <Group justify="space-between"><Text size="sm" c="dimmed">Database</Text><Badge variant="light" color="blue">Firebase RTDB</Badge></Group>
                <Group justify="space-between"><Text size="sm" c="dimmed">Functions region</Text><Badge variant="light">europe-west1</Badge></Group>
              </Stack>
            </Paper>
            <Alert icon={<IconCheck size={16} />} color="green" variant="light">
              This screen only exposes controls that are connected to a live backend behavior.
            </Alert>
          </Stack>
        </SettingsSection>
      </SimpleGrid>

      <Modal opened={passwordModalOpened} onClose={closePassword} title="Change Password" centered>
        <form onSubmit={handlePasswordChange}>
          <Stack gap="md">
            <Alert icon={<IconAlertCircle size={16} />} color="yellow" variant="light">
              Enter your current password to reauthenticate this session.
            </Alert>
            <PasswordInput label="Current password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
            <PasswordInput label="New password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} description="At least 8 characters" required />
            <PasswordInput label="Confirm new password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} error={confirmPassword && newPassword !== confirmPassword ? 'Passwords do not match' : null} required />
            <Group justify="flex-end" mt="md">
              <Button variant="light" onClick={closePassword}>Cancel</Button>
              <Button type="submit" loading={changingPassword}>Update password</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Box>
  );
}
