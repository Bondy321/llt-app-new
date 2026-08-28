import { useEffect, useRef, useState } from 'react';
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
  Switch,
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
  IconDeviceMobile,
  IconRefresh,
  IconUser,
} from '@tabler/icons-react';
import { changeCurrentAccountPassword, getCurrentAccountUser } from '../services/accountSecurityService';
import { getDriverLoginPolicy, setDriverLoginPolicy } from '../services/driverLoginPolicyService';

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
  const [driverPolicy, setDriverPolicy] = useState(null);
  const [driverPolicyError, setDriverPolicyError] = useState('');
  const [loadingDriverPolicy, setLoadingDriverPolicy] = useState(true);
  const [savingDriverPolicy, setSavingDriverPolicy] = useState(false);
  const [enableDriverPolicyOpened, setEnableDriverPolicyOpened] = useState(false);
  const driverPolicyRequestId = useRef(0);

  const loadDriverPolicy = async () => {
    const requestId = driverPolicyRequestId.current + 1;
    driverPolicyRequestId.current = requestId;
    setLoadingDriverPolicy(true);
    setDriverPolicyError('');
    try {
      const policy = await getDriverLoginPolicy();
      if (driverPolicyRequestId.current === requestId) setDriverPolicy(policy);
    } catch (error) {
      if (driverPolicyRequestId.current === requestId) {
        setDriverPolicyError(error instanceof Error ? error.message : 'Driver device settings could not be loaded.');
      }
    } finally {
      if (driverPolicyRequestId.current === requestId) setLoadingDriverPolicy(false);
    }
  };

  useEffect(() => {
    const requestId = driverPolicyRequestId.current + 1;
    driverPolicyRequestId.current = requestId;
    let active = true;
    getDriverLoginPolicy()
      .then((policy) => {
        if (active && driverPolicyRequestId.current === requestId) setDriverPolicy(policy);
      })
      .catch((error) => {
        if (active && driverPolicyRequestId.current === requestId) {
          setDriverPolicyError(error instanceof Error ? error.message : 'Driver device settings could not be loaded.');
        }
      })
      .finally(() => {
        if (active && driverPolicyRequestId.current === requestId) setLoadingDriverPolicy(false);
      });
    return () => {
      active = false;
      if (driverPolicyRequestId.current === requestId) driverPolicyRequestId.current += 1;
    };
  }, []);

  const saveDriverPolicy = async (enforceSingleDevice) => {
    if (!driverPolicy || savingDriverPolicy) return;
    setSavingDriverPolicy(true);
    setDriverPolicyError('');
    try {
      const result = await setDriverLoginPolicy({
        enforceSingleDevice,
        expectedRevision: driverPolicy.revision,
      });
      driverPolicyRequestId.current += 1;
      setDriverPolicy(result.policy);
      setEnableDriverPolicyOpened(false);
      const cleanupSummary = result.cleanup.queued
        ? `${result.cleanup.cleaned} of ${result.cleanup.queued} old session record(s) cleaned; ${result.cleanup.pending} remain queued.`
        : 'There were no current driver sessions to clean up.';
      notifications.show({
        title: result.policy.transition
          ? 'Driver sign-in change in progress'
          : (enforceSingleDevice ? 'Single-device login enabled' : 'Multiple driver handsets allowed'),
        message: result.policy.transition
          ? `Driver sign-in settings are being updated. ${cleanupSummary}`
          : enforceSingleDevice
          ? `Existing driver access was revoked immediately. ${cleanupSummary} The next handset to log in becomes the linked device.`
          : 'Drivers can now use their driver code on more than one valid handset.',
        color: result.policy.transition || result.cleanup.pending ? 'yellow' : 'green',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Driver device settings could not be updated.';
      setDriverPolicyError(message);
      notifications.show({ title: 'Setting not changed', message, color: 'red' });
      if (error?.code === 'POLICY_CHANGED') {
        setEnableDriverPolicyOpened(false);
        await loadDriverPolicy();
      }
    } finally {
      setSavingDriverPolicy(false);
    }
  };

  const handleDriverPolicyToggle = (event) => {
    if (event.currentTarget.checked) setEnableDriverPolicyOpened(true);
    else saveDriverPolicy(false);
  };

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

        <SettingsSection title="Driver handsets" description="Control whether a driver code is limited to one handset" icon={IconDeviceMobile} color="violet">
          <Stack gap="md">
            {driverPolicyError && (
              <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
                <Group justify="space-between" align="center">
                  <Text size="sm">{driverPolicyError}</Text>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconRefresh size={14} />}
                    loading={loadingDriverPolicy}
                    disabled={savingDriverPolicy}
                    onClick={loadDriverPolicy}
                  >
                    Retry
                  </Button>
                </Group>
              </Alert>
            )}
            <Paper p="md" radius="md" withBorder>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Group gap="xs">
                    <Text fw={500}>Limit each driver code to one handset</Text>
                    {driverPolicy && (
                      <Badge color={driverPolicy.transition ? 'yellow' : (driverPolicy.enforceSingleDevice ? 'orange' : 'green')} variant="light">
                        {driverPolicy.transition ? 'Updating' : (driverPolicy.enforceSingleDevice ? 'On' : 'Off')}
                      </Badge>
                    )}
                  </Group>
                  <Text size="sm" c="dimmed" mt={4} maw={520}>
                    When off, a driver can use the same driver code on multiple company handsets. Each handset still needs its own current, verified app session.
                  </Text>
                </div>
                <Switch
                  aria-label="Limit each driver code to one handset"
                  aria-busy={loadingDriverPolicy || savingDriverPolicy}
                  aria-describedby="driver-policy-status"
                  checked={driverPolicy?.enforceSingleDevice === true}
                  disabled={loadingDriverPolicy || savingDriverPolicy || !driverPolicy || Boolean(driverPolicy.transition)}
                  onChange={handleDriverPolicyToggle}
                />
              </Group>
            </Paper>
            <Text id="driver-policy-status" role="status" aria-live="polite" size="xs" c="dimmed">
              {loadingDriverPolicy
                ? 'Checking the current driver handset setting…'
                : savingDriverPolicy
                  ? 'Applying the driver handset setting…'
                  : !driverPolicy
                    ? 'The current driver handset setting is unavailable.'
                    : driverPolicy.transition
                      ? 'Driver sign-in settings are being updated. Please wait before making another change.'
                    : driverPolicy.enforceSingleDevice
                      ? 'Single-device enforcement is active.'
                      : 'Multiple verified company handsets are allowed.'}
            </Text>
            {driverPolicy?.isDefault && (
              <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
                Default: multiple verified company handsets are allowed.
              </Alert>
            )}
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

      <Modal
        opened={enableDriverPolicyOpened}
        onClose={() => !savingDriverPolicy && setEnableDriverPolicyOpened(false)}
        title="Enable single-device driver login?"
        centered
      >
        <Stack gap="md">
          <Alert icon={<IconAlertCircle size={16} />} color="orange" variant="light">
            This immediately revokes app access for every current driver handset. Old session records and device links are then cleaned up safely in the background. The first handset to log in again with each driver code becomes that driver&apos;s only linked device.
          </Alert>
          <Text size="sm">
            Passenger and web-admin sessions are not affected. You can turn this setting off again at any time.
          </Text>
          <Group justify="flex-end">
            <Button variant="light" disabled={savingDriverPolicy} onClick={() => setEnableDriverPolicyOpened(false)}>Cancel</Button>
            <Button color="orange" loading={savingDriverPolicy} onClick={() => saveDriverPolicy(true)}>Enable and revoke driver access</Button>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
