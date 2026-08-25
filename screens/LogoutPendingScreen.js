import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';

export default function LogoutPendingScreen({
  isConnected,
  isRetrying = false,
  error = null,
  diagnostic = null,
  onRetry,
}) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.card} accessibilityRole="summary">
        <ActivityIndicator size="large" color={COLORS.primary} accessibilityLabel="Logout pending" />
        <Text style={styles.title}>Logout pending</Text>
        <Text style={styles.body}>
          Your tour data has been removed from this device. We still need an internet connection to end access on the server.
        </Text>
        <View style={[styles.status, isConnected ? styles.online : styles.offline]}>
          <Text style={styles.statusText}>{isConnected ? 'Connection available' : 'Waiting for a connection'}</Text>
        </View>
        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
        {diagnostic ? <Text style={styles.diagnostic}>Reference: {diagnostic}</Text> : null}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Try ending the session again"
          disabled={!isConnected || isRetrying}
          onPress={onRetry}
          style={[styles.button, (!isConnected || isRetrying) && styles.buttonDisabled]}
        >
          {isRetrying ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.buttonText}>Try again</Text>}
        </TouchableOpacity>
        <Text style={styles.note}>You cannot reopen the previous tour while logout is pending.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background, justifyContent: 'center', padding: 24 },
  card: { backgroundColor: COLORS.white, borderRadius: 18, padding: 24, alignItems: 'center' },
  title: { marginTop: 16, color: COLORS.textPrimary, fontSize: 24, fontWeight: '800', textAlign: 'center' },
  body: { marginTop: 12, color: COLORS.textSecondary, fontSize: 16, lineHeight: 24, textAlign: 'center' },
  status: { marginTop: 18, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  online: { backgroundColor: '#DCFCE7' },
  offline: { backgroundColor: '#FEF3C7' },
  statusText: { color: COLORS.textPrimary, fontSize: 14, fontWeight: '700' },
  error: { marginTop: 14, color: COLORS.error, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  diagnostic: { marginTop: 8, color: COLORS.textSecondary, fontSize: 12 },
  button: { marginTop: 22, minHeight: 48, minWidth: 180, borderRadius: 12, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  note: { marginTop: 16, color: COLORS.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center' },
});
