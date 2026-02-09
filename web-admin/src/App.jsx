import { useState, useEffect } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { auth } from './firebase';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail } from 'firebase/auth';
import { notifications } from '@mantine/notifications';
import {
  AppShell,
  Burger,
  Group,
  NavLink as MantineNavLink,
  Text,
  Title,
  Button,
  TextInput,
  PasswordInput,
  Paper,
  Stack,
  Box,
  Avatar,
  Menu,
  Divider,
  Loader,
  Center,
  ThemeIcon,
  Tooltip,
  ActionIcon,
  Anchor,
  Modal,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconDashboard,
  IconUsers,
  IconBus,
  IconSpeakerphone,
  IconSettings,
  IconLogout,
  IconUser,
  IconChevronDown,
  IconMap,
  IconBell,
  IconSearch,
} from '@tabler/icons-react';

// Import page components
import Dashboard from './components/Dashboard';
import { DriversManager } from './components/DriversManager';
import ToursManager from './components/ToursManager';
import { BroadcastPanel } from './components/BroadcastPanel';
import Settings from './components/Settings';

// Navigation items configuration
const navItems = [
  { path: '/', label: 'Dashboard', icon: IconDashboard, color: 'brand' },
  { path: '/drivers', label: 'Driver Management', icon: IconUsers, color: 'blue' },
  { path: '/tours', label: 'Tours', icon: IconMap, color: 'green' },
  { path: '/broadcast', label: 'Broadcast', icon: IconSpeakerphone, color: 'orange' },
  { path: '/settings', label: 'Settings', icon: IconSettings, color: 'gray' },
];

// Login Component
function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please enter both email and password',
        color: 'red',
      });
      return;
    }

    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      notifications.show({
        title: 'Welcome Back!',
        message: 'Successfully logged in to Loch Lomond Admin',
        color: 'green',
      });
    } catch (err) {
      let message = 'Login failed. Please try again.';
      if (err.code === 'auth/invalid-credential') {
        message = 'Invalid email or password. Please check your credentials.';
      } else if (err.code === 'auth/too-many-requests') {
        message = 'Too many failed attempts. Please try again later.';
      } else if (err.code === 'auth/network-request-failed') {
        message = 'Network error. Please check your connection.';
      }
      notifications.show({
        title: 'Login Failed',
        message,
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordReset = async (e) => {
    e.preventDefault();
    if (!resetEmail) {
      notifications.show({
        title: 'Email Required',
        message: 'Please enter your email address',
        color: 'red',
      });
      return;
    }

    setResetLoading(true);
    try {
      await sendPasswordResetEmail(auth, resetEmail);
      notifications.show({
        title: 'Reset Email Sent',
        message: 'Check your inbox for password reset instructions',
        color: 'green',
      });
      setResetModalOpen(false);
      setResetEmail('');
    } catch (err) {
      let message = 'Unable to send reset email. Please try again later.';
      if (err.code === 'auth/invalid-email') {
        message = 'Please enter a valid email address.';
      } else if (err.code === 'auth/too-many-requests') {
        message = 'Too many attempts. Please try again later.';
      }
      notifications.show({
        title: 'Reset Failed',
        message,
        color: 'red',
      });
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #007DC3 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <Paper shadow="xl" p="xl" radius="lg" style={{ width: '100%', maxWidth: 420 }}>
        <Stack gap="lg">
          {/* Logo/Brand */}
          <Box ta="center">
            <ThemeIcon size={60} radius="xl" variant="gradient" gradient={{ from: 'brand', to: 'cyan' }}>
              <IconBus size={32} />
            </ThemeIcon>
            <Title order={2} mt="md" c="brand">
              Loch Lomond Travel
            </Title>
            <Text c="dimmed" size="sm">
              Operations Admin Portal
            </Text>
          </Box>

          <Divider />

          {/* Login Form */}
          <form onSubmit={handleLogin}>
            <Stack gap="md">
              <TextInput
                label="Email Address"
                placeholder="admin@lochlomond.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                leftSection={<IconUser size={16} />}
                required
              />
              <PasswordInput
                label="Password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button
                type="submit"
                fullWidth
                loading={loading}
                variant="gradient"
                gradient={{ from: 'brand', to: 'cyan' }}
                size="md"
              >
                Sign In
              </Button>
            </Stack>
          </form>

          <Text ta="center" size="sm" c="dimmed">
            Forgot your password?{' '}
            <Anchor component="button" type="button" size="sm" onClick={() => setResetModalOpen(true)}>
              Reset it here
            </Anchor>
          </Text>
        </Stack>
      </Paper>

      {/* Password Reset Modal */}
      <Modal
        opened={resetModalOpen}
        onClose={() => setResetModalOpen(false)}
        title="Reset Password"
        centered
      >
        <form onSubmit={handlePasswordReset}>
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Enter your email address and we'll send you instructions to reset your password.
            </Text>
            <TextInput
              label="Email Address"
              placeholder="admin@lochlomond.com"
              value={resetEmail}
              onChange={(e) => setResetEmail(e.target.value)}
              leftSection={<IconUser size={16} />}
              required
            />
            <Group justify="flex-end" mt="md">
              <Button variant="light" onClick={() => setResetModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={resetLoading}>
                Send Reset Email
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Box>
  );
}

// Main App Layout Component
function AppLayout({ user }) {
  const [opened, { toggle }] = useDisclosure();
  const location = useLocation();

  const handleLogout = async () => {
    try {
      await signOut(auth);
      notifications.show({
        title: 'Logged Out',
        message: 'You have been successfully logged out',
        color: 'blue',
      });
    } catch {
      notifications.show({
        title: 'Error',
        message: 'Failed to log out. Please try again.',
        color: 'red',
      });
    }
  };

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 280, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      {/* Header */}
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Group gap="xs">
              <ThemeIcon size="lg" radius="md" variant="gradient" gradient={{ from: 'brand', to: 'cyan' }}>
                <IconBus size={20} />
              </ThemeIcon>
              <Box visibleFrom="xs">
                <Text fw={700} size="lg" c="brand">Loch Lomond Travel</Text>
              </Box>
            </Group>
          </Group>

          <Group gap="md">
            {/* Search */}
            <TextInput
              placeholder="Search..."
              leftSection={<IconSearch size={16} />}
              size="sm"
              style={{ width: 200 }}
              visibleFrom="md"
            />

            {/* Notifications */}
            <Tooltip label="Notifications">
              <ActionIcon variant="light" size="lg">
                <IconBell size={18} />
              </ActionIcon>
            </Tooltip>

            {/* User Menu */}
            <Menu shadow="md" width={200} position="bottom-end">
              <Menu.Target>
                <Button variant="subtle" color="gray" rightSection={<IconChevronDown size={14} />}>
                  <Group gap="xs">
                    <Avatar size="sm" radius="xl" color="brand">
                      {user?.email?.charAt(0).toUpperCase()}
                    </Avatar>
                    <Box visibleFrom="sm">
                      <Text size="sm" fw={500}>{user?.email?.split('@')[0]}</Text>
                    </Box>
                  </Group>
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Account</Menu.Label>
                <Menu.Item leftSection={<IconUser size={14} />}>
                  Profile
                </Menu.Item>
                <Menu.Item leftSection={<IconSettings size={14} />}>
                  Preferences
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  leftSection={<IconLogout size={14} />}
                  onClick={handleLogout}
                >
                  Logout
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      {/* Navigation Sidebar */}
      <AppShell.Navbar p="md">
        <AppShell.Section grow>
          <Stack gap="xs">
            {navItems.map((item) => (
              <MantineNavLink
                key={item.path}
                component={NavLink}
                to={item.path}
                label={item.label}
                leftSection={
                  <ThemeIcon variant={location.pathname === item.path ? 'filled' : 'light'} color={item.color} size="md">
                    <item.icon size={16} />
                  </ThemeIcon>
                }
                active={location.pathname === item.path}
                onClick={() => opened && toggle()}
                style={{ borderRadius: 8 }}
              />
            ))}
          </Stack>
        </AppShell.Section>

        <AppShell.Section>
          <Divider my="sm" />
          <Paper p="sm" radius="md" bg="gray.0">
            <Group gap="xs">
              <Avatar size="sm" radius="xl" color="brand">
                {user?.email?.charAt(0).toUpperCase()}
              </Avatar>
              <Box style={{ flex: 1 }}>
                <Text size="xs" fw={500} truncate="end">
                  {user?.email}
                </Text>
                <Text size="xs" c="dimmed">Administrator</Text>
              </Box>
            </Group>
          </Paper>
        </AppShell.Section>
      </AppShell.Navbar>

      {/* Main Content */}
      <AppShell.Main style={{ backgroundColor: '#f8f9fa' }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/drivers" element={<DriversManager />} />
          <Route path="/tours" element={<ToursManager />} />
          <Route path="/broadcast" element={<BroadcastPanel />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}

// Main App Component
function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Show loading while checking auth state
  if (loading) {
    return (
      <Center style={{ minHeight: '100vh' }}>
        <Stack align="center" gap="md">
          <Loader size="xl" color="brand" />
          <Text c="dimmed">Loading...</Text>
        </Stack>
      </Center>
    );
  }

  // Show login if not authenticated
  if (!user) {
    return <LoginPage />;
  }

  // Show main app
  return <AppLayout user={user} />;
}

export default App;
