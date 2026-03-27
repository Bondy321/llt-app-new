import { useCallback, useEffect, useMemo, useState } from 'react';
import { auth } from '../firebase';
import { updatePassword, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth';
import { ref, get, update, serverTimestamp } from 'firebase/database';
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
  Progress,
  Skeleton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconUser,
  IconLock,
  IconBell,
  IconDatabase,
  IconShield,
  IconKey,
  IconMail,
  IconAlertCircle,
  IconCheck,
  IconInfoCircle,
  IconDeviceFloppy,
  IconRefresh,
  IconRotateClockwise2,
} from '@tabler/icons-react';
import { db } from '../firebase';

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

const DEFAULT_NOTIFICATION_SETTINGS = {
  pushNotifications: true,
  emailNotifications: true,
  soundEnabled: true,
  highPriorityOnly: false,
  dailyDigest: true,
};

// Main Settings Component
export default function Settings() {
  const user = auth.currentUser;
  const [passwordModalOpened, { open: openPasswordModal, close: closePasswordModal }] = useDisclosure(false);
  const [resetModalOpened, { open: openResetModal, close: closeResetModal }] = useDisclosure(false);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  // Settings state (persisted)
  const [notificationSettings, setNotificationSettings] = useState(DEFAULT_NOTIFICATION_SETTINGS);
  const [initialSettings, setInitialSettings] = useState(DEFAULT_NOTIFICATION_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);

  const settingsRef = useMemo(
    () => (user?.uid ? ref(db, `web_admin_settings/${user.uid}`) : null),
    [user?.uid]
  );

  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(notificationSettings) !== JSON.stringify(initialSettings),
    [notificationSettings, initialSettings]
  );

  const securityScore = useMemo(() => {
    let score = 70;
    if (notificationSettings.highPriorityOnly) score += 5;
    if (!notificationSettings.soundEnabled) score += 5;
    if (notificationSettings.dailyDigest) score += 5;
    if (user?.emailVerified) score += 15;
    return Math.min(score, 100);
  }, [notificationSettings, user?.emailVerified]);

  const loadSettings = useCallback(async () => {
    if (!settingsRef) {
      setSettingsLoading(false);
      return;
    }

    setSettingsLoading(true);
    try {
      const snapshot = await get(settingsRef);
      const data = snapshot.val() || {};
      const nextSettings = {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        ...(data.notificationSettings || {}),
      };

      setNotificationSettings(nextSettings);
      setInitialSettings(nextSettings);
      setLastSavedAt(data?.updatedAtISO || null);
    } catch {
      notifications.show({
        title: 'Settings load issue',
        message: 'Unable to load saved preferences right now. You can still update and save manually.',
        color: 'yellow',
      });
    } finally {
      setSettingsLoading(false);
    }
  }, [settingsRef]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

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

    if (newPassword.length < 8) {
      notifications.show({
        title: 'Weak Password',
        message: 'Password must be at least 8 characters long',
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

  const handleSettingToggle = (key) => {
    setNotificationSettings((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const handleSaveSettings = async () => {
    if (!settingsRef || settingsSaving || !hasUnsavedChanges) return;

    setSettingsSaving(true);
    const savedAt = new Date().toISOString();
    try {
      await update(settingsRef, {
        notificationSettings,
        updatedAt: serverTimestamp(),
        updatedAtISO: savedAt,
      });

      setInitialSettings(notificationSettings);
      setLastSavedAt(savedAt);
      notifications.show({
        title: 'Settings saved',
        message: 'Your preferences are now live for this admin account.',
        color: 'green',
      });
    } catch {
      notifications.show({
        title: 'Save failed',
        message: 'Could not save your settings. Please retry.',
        color: 'red',
      });
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleResetToDefaults = async () => {
    setNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
    closeResetModal();
  };

  const renderLastSaved = () => {
    if (!lastSavedAt) return 'Not saved yet';
    const parsed = new Date(lastSavedAt);
    if (Number.isNaN(parsed.getTime())) return 'Saved recently';
    return parsed.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Box>
      {/* Header */}
      <Card mb="xl" radius="lg" withBorder p="xl" bg="linear-gradient(135deg, var(--mantine-color-brand-0), var(--mantine-color-white))">
        <Group justify="space-between" align="start">
          <div>
            <Title order={2}>Settings</Title>
            <Text c="dimmed" size="sm">Premium account controls, secure defaults, and production-ready preference management.</Text>
            <Text mt={6} size="xs" c="dimmed">Last saved: {renderLastSaved()}</Text>
          </div>
          <Group gap="xs">
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={loadSettings}
              loading={settingsLoading}
            >
              Refresh
            </Button>
            <Button
              leftSection={<IconDeviceFloppy size={16} />}
              onClick={handleSaveSettings}
              loading={settingsSaving}
              disabled={!hasUnsavedChanges}
            >
              Save changes
            </Button>
          </Group>
        </Group>
        <Progress mt="md" value={securityScore} color={securityScore >= 85 ? 'green' : 'yellow'} size="lg" radius="xl" />
        <Group justify="space-between" mt="xs">
          <Text size="xs" c="dimmed">Workspace security posture</Text>
          <Text size="xs" fw={700}>{securityScore}/100</Text>
        </Group>
      </Card>

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
          description="Fine-grained operational alert routing"
          icon={IconBell}
          color="orange"
        >
          <Stack gap="md">
            {settingsLoading ? (
              <>
                <Skeleton height={54} radius="md" />
                <Skeleton height={54} radius="md" />
                <Skeleton height={54} radius="md" />
              </>
            ) : (
              <>
                <Group justify="space-between">
                  <div>
                    <Text fw={500}>Push Notifications</Text>
                    <Text size="xs" c="dimmed">Receive alerts in your browser</Text>
                  </div>
                  <Switch
                    checked={notificationSettings.pushNotifications}
                    onChange={() => handleSettingToggle('pushNotifications')}
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
                    checked={notificationSettings.emailNotifications}
                    onChange={() => handleSettingToggle('emailNotifications')}
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
                    checked={notificationSettings.soundEnabled}
                    onChange={() => handleSettingToggle('soundEnabled')}
                    color="brand"
                  />
                </Group>
                <Divider />
                <Group justify="space-between">
                  <div>
                    <Text fw={500}>High-priority only mode</Text>
                    <Text size="xs" c="dimmed">Silence low-urgency updates during operations</Text>
                  </div>
                  <Switch
                    checked={notificationSettings.highPriorityOnly}
                    onChange={() => handleSettingToggle('highPriorityOnly')}
                    color="brand"
                  />
                </Group>
                <Divider />
                <Group justify="space-between">
                  <div>
                    <Text fw={500}>Daily Digest</Text>
                    <Text size="xs" c="dimmed">Receive a daily operations summary</Text>
                  </div>
                  <Switch
                    checked={notificationSettings.dailyDigest}
                    onChange={() => handleSettingToggle('dailyDigest')}
                    color="brand"
                  />
                </Group>
              </>
            )}

            <Group justify="space-between" mt="xs">
              <Button variant="default" onClick={() => setNotificationSettings(initialSettings)} disabled={!hasUnsavedChanges}>
                Revert Changes
              </Button>
              <Button variant="subtle" color="red" onClick={openResetModal} leftSection={<IconRotateClockwise2 size={16} />}>
                Reset Defaults
              </Button>
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
                  <Badge variant="light">1.1.0</Badge>
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
                  <Badge variant="light">europe-west1</Badge>
                </Group>
              </Stack>
            </Paper>

            <Alert icon={<IconCheck size={16} />} color="green" variant="light">
              Settings persistence and security controls are operational.
            </Alert>
          </Stack>
        </SettingsSection>
      </SimpleGrid>

      {hasUnsavedChanges ? (
        <Alert mt="lg" color="yellow" icon={<IconAlertCircle size={16} />} variant="light">
          You have unsaved changes. Save now to publish these preferences to production.
        </Alert>
      ) : null}

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
              description="Must be at least 8 characters"
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

      <Modal opened={resetModalOpened} onClose={closeResetModal} centered title="Reset notification preferences?">
        <Stack>
          <Text size="sm" c="dimmed">
            This resets alert preferences to LLT recommended defaults. Your changes are only saved after you click “Save changes”.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={closeResetModal}>Cancel</Button>
            <Button color="red" onClick={handleResetToDefaults}>Reset</Button>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
