import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Animated, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import LogoutPendingScreen from '../../screens/LogoutPendingScreen';
import AccountDeletionPendingScreen from '../../screens/AccountDeletionPendingScreen';
import AppScreenRouter from './navigation/AppScreenRouter';
import { COLORS, styles } from './AppShell.styles';

export default function AppShellView({
  accountDeletionStatus,
  authError,
  edgeSwipeResponder,
  initializing,
  insets,
  isConnected,
  loginProgress,
  loginTransition,
  logoutStatus,
  retryInitialization,
  retryPendingLogout,
  retryAccountDeletion,
  finishAccountDeletion,
  routerProps,
}) {
  if (initializing) {
    return (
      <SafeAreaView style={styles.loadingContainer} edges={['top']}>
        <ActivityIndicator size="large" color={COLORS.primaryBlue} />
        <Text style={styles.loadingText}>Connecting to Tour Services...</Text>
      </SafeAreaView>
    );
  }

  if (accountDeletionStatus.state !== 'idle') {
    return (
      <AccountDeletionPendingScreen
        state={accountDeletionStatus.state}
        phase={accountDeletionStatus.phase}
        error={accountDeletionStatus.error}
        isConnected={isConnected}
        isRetrying={false}
        onRetry={retryAccountDeletion}
        onDone={finishAccountDeletion}
      />
    );
  }

  if (logoutStatus.state === 'requesting'
    || logoutStatus.state === 'pending_network'
    || logoutStatus.state === 'failed') {
    return (
      <LogoutPendingScreen
        isConnected={isConnected}
        isRetrying={logoutStatus.state === 'requesting'}
        error={logoutStatus.error}
        diagnostic={logoutStatus.diagnostic}
        onRetry={retryPendingLogout}
      />
    );
  }

  if (authError) {
    return (
      <SafeAreaView style={styles.loadingContainer} edges={['top']}>
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorTitle}>Connection Error</Text>
        <Text style={styles.errorText}>{authError}</Text>
        <Text style={styles.errorDetail}>Check your internet connection, then try again. Your saved tour remains on this device.</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Retry connecting to tour services"
          style={styles.retryButton}
          onPress={retryInitialization}
        >
          <Text style={styles.retryButtonText}>Try again</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <>
      <StatusBar style="light" backgroundColor={COLORS.statusBarBackground} />
      <View pointerEvents="none" style={[styles.statusBarScrim, { height: insets.top }]} />
      {loginTransition ? (
        <View style={[styles.loginTransitionOverlay, { top: insets.top + 8 }]}>
          <Text style={styles.loginTransitionText}>{loginTransition.message}</Text>
          <View style={styles.loginTransitionTrack}>
            <Animated.View
              style={[
                styles.loginTransitionFill,
                {
                  width: loginProgress.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                },
              ]}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.screenContainer} {...edgeSwipeResponder.panHandlers}>
        <AppScreenRouter {...routerProps} />
      </View>
    </>
  );
}
