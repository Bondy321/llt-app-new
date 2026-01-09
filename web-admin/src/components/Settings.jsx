import { useState } from 'react';
import { auth } from '../firebase';
import { updatePassword, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth';
import { notifications } from '@mantine/notifications';
import {
  Card,
  Text,
  Title,
  Group,
  Button,
  TextInput,
  PasswordInput,
  Stack,
  Box,
  Badge,
  Switch,
  Divider,
  Paper,
  ThemeIcon,
  SimpleGrid,
  Avatar,
  Modal,
  Alert,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconSettings,
  IconUser,
  IconLock,
  IconBell,
  IconPalette,
  IconDatabase,
  IconShield,
  IconKey,
  IconMail,
  IconAlertCircle,
  IconCheck,
  IconInfoCircle,
} from '@tabler/icons-react';

// Settings Section Component
function SettingsSection({ title, description, icon, color, children }) {
  const Icon = icon;
  return (
    <Card shadow="sm" padding="lg" radius="md" withBorder>
      <Group gap="md" mb="lg">
        <ThemeIcon color={color} variant="light" size="lg" radius="md">
          <Icon size={20} />
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

// Main Settings Component
export default function Settings() {
  const user = auth.currentUser;
  const [passwordModalOpened, { open: openPasswordModal, close: closePasswordModal }] = useDisclosure(false);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  // Settings state
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const handlePasswordChange = async (e) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      notifications.show({
        title: 'Password Mismatch',
        message: 'New password and confirmation do not match',
        color: 'red',
      });
      return;
    }

    if (newPassword.length < 6) {
      notifications.show({
        title: 'Weak Password',
        message: 'Password must be at least 6 characters long',
        color: 'red',
      });
      return;
    }

    setChangingPassword(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, currentPassword);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPassword);

      notifications.show({
        title: 'Password Updated',
        message: 'Your password has been changed successfully',
        color: 'green',
      });
      closePasswordModal();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      let message = 'Failed to change password';
      if (error.code === 'auth/wrong-password') {
        message = 'Current password is incorrect';
      } else if (error.code === 'auth/too-many-requests') {
        message = 'Too many attempts. Please try again later';
      }
      notifications.show({
        title: 'Error',
        message,
        color: 'red',
      });
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <Box>
      {/* Header */}
      <Group justify="space-between" mb="xl">
        <div>
          <Title order={2}>Settings</Title>
          <Text c="dimmed" size="sm">Manage your account and application preferences</Text>
        </div>
      </Group>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        {/* Profile Settings */}
        <SettingsSection
          title="Profile"
          description="Your account information"
          icon={IconUser}
          color="brand"
        >
          <Stack gap="md">
            <Paper p="md" radius="md" bg="gray.0">
              <Group gap="md">
                <Avatar size="lg" radius="xl" color="brand">
                  {user?.email?.charAt(0).toUpperCase()}
                </Avatar>
                <div>
                  <Text fw={500}>{user?.email?.split('@')[0]}</Text>
                  <Text size="sm" c="dimmed">{user?.email}</Text>
                </div>
                <Badge ml="auto" variant="light" color="green">Admin</Badge>
              </Group>
            </Paper>

            <TextInput
              label="Email Address"
              value={user?.email || ''}
              disabled
              leftSection={<IconMail size={16} />}
              description="Contact support to change your email"
            />

            <TextInput
              label="Account ID"
              value={user?.uid || ''}
              disabled
              leftSection={<IconUser size={16} />}
            />
          </Stack>
        </SettingsSection>

        {/* Security Settings */}
        <SettingsSection
          title="Security"
          description="Password and authentication"
          icon={IconShield}
          color="red"
        >
          <Stack gap="md">
            <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
              Keep your account secure by using a strong, unique password
            </Alert>

            <Paper p="md" radius="md" withBorder>
              <Group justify="space-between">
                <Group gap="md">
                  <ThemeIcon color="gray" variant="light" size="lg" radius="md">
                    <IconKey size={18} />
                  </ThemeIcon>
                  <div>
                    <Text fw={500}>Password</Text>
                    <Text size="xs" c="dimmed">Last changed: Unknown</Text>
                  </div>
                </Group>
                <Button variant="light" onClick={openPasswordModal}>
                  Change
                </Button>
              </Group>
            </Paper>

            <Paper p="md" radius="md" withBorder>
              <Group justify="space-between">
                <Group gap="md">
                  <ThemeIcon color="green" variant="light" size="lg" radius="md">
                    <IconLock size={18} />
                  </ThemeIcon>
                  <div>
                    <Text fw={500}>Session</Text>
                    <Text size="xs" c="dimmed">Currently logged in</Text>
                  </div>
                </Group>
                <Badge color="green" variant="filled">Active</Badge>
              </Group>
            </Paper>
          </Stack>
        </SettingsSection>

        {/* Notification Settings */}
        <SettingsSection
          title="Notifications"
          description="Configure alert preferences"
          icon={IconBell}
          color="orange"
        >
          <Stack gap="md">
            <Group justify="space-between">
              <div>
                <Text fw={500}>Push Notifications</Text>
                <Text size="xs" c="dimmed">Receive alerts in your browser</Text>
              </div>
              <Switch
                checked={notificationsEnabled}
                onChange={(e) => setNotificationsEnabled(e.currentTarget.checked)}
                color="brand"
              />
            </Group>
            <Divider />
            <Group justify="space-between">
              <div>
                <Text fw={500}>Email Notifications</Text>
                <Text size="xs" c="dimmed">Receive important updates via email</Text>
              </div>
              <Switch
                checked={emailNotifications}
                onChange={(e) => setEmailNotifications(e.currentTarget.checked)}
                color="brand"
              />
            </Group>
            <Divider />
            <Group justify="space-between">
              <div>
                <Text fw={500}>Sound Effects</Text>
                <Text size="xs" c="dimmed">Play sounds for notifications</Text>
              </div>
              <Switch
                checked={soundEnabled}
                onChange={(e) => setSoundEnabled(e.currentTarget.checked)}
                color="brand"
              />
            </Group>
          </Stack>
        </SettingsSection>

        {/* System Information */}
        <SettingsSection
          title="System Information"
          description="Application and database details"
          icon={IconDatabase}
          color="green"
        >
          <Stack gap="md">
            <Paper p="md" radius="md" bg="gray.0">
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Version</Text>
                  <Badge variant="light">1.0.0</Badge>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Environment</Text>
                  <Badge variant="light" color="green">Production</Badge>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Database</Text>
                  <Badge variant="light" color="blue">Firebase RTDB</Badge>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Region</Text>
                  <Badge variant="light">Europe West 1</Badge>
                </Group>
              </Stack>
            </Paper>

            <Alert icon={<IconCheck size={16} />} color="green" variant="light">
              All systems operational
            </Alert>
          </Stack>
        </SettingsSection>
      </SimpleGrid>

      {/* Password Change Modal */}
      <Modal
        opened={passwordModalOpened}
        onClose={closePasswordModal}
        title="Change Password"
        centered
      >
        <form onSubmit={handlePasswordChange}>
          <Stack gap="md">
            <Alert icon={<IconAlertCircle size={16} />} color="yellow" variant="light">
              You will need to enter your current password to make this change
            </Alert>

            <PasswordInput
              label="Current Password"
              placeholder="Enter current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />

            <PasswordInput
              label="New Password"
              placeholder="Enter new password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              description="Must be at least 6 characters"
              required
            />

            <PasswordInput
              label="Confirm New Password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={confirmPassword && newPassword !== confirmPassword ? 'Passwords do not match' : null}
              required
            />

            <Group justify="flex-end" mt="md">
              <Button variant="light" onClick={closePasswordModal}>
                Cancel
              </Button>
              <Button type="submit" loading={changingPassword}>
                Update Password
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Box>
  );
}
