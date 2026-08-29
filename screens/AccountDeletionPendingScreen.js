import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { COLORS, FONT_WEIGHT, RADIUS, SPACING } from '../theme';

const copyForState = ({ state, isConnected }) => {
  if (state === 'completed') return {
    icon: 'check-circle-outline',
    title: 'Account deletion complete',
    body: 'Your app account has been deleted. Travel booking records may still be retained where required for operations, safety, legal, or accounting reasons.',
  };
  if (state === 'requires_attention') return {
    icon: 'alert-circle-outline',
    title: 'Deletion needs attention',
    body: 'Your old app access remains blocked while Loch Lomond Travel completes the remaining deletion steps. You can safely close the app.',
  };
  if (state === 'waiting_for_connection' || !isConnected) return {
    icon: 'cloud-off-outline',
    title: 'Deletion is still in progress',
    body: 'This device is offline. Your secure recovery receipt is saved and the app will check again when a connection returns.',
  };
  return {
    icon: 'shield-clock-outline',
    title: 'Deleting your app account',
    body: 'The secure deletion request is being completed by Loch Lomond Travel services. You can safely close the app and return later.',
  };
};

export default function AccountDeletionPendingScreen({
  state,
  phase,
  error,
  isConnected,
  isRetrying = false,
  onRetry,
  onDone,
}) {
  const copy = copyForState({ state, isConnected });
  const completed = state === 'completed';
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.card}>
        <MaterialCommunityIcons name={copy.icon} size={46} color={completed ? COLORS.success : COLORS.primary} />
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.body}>{copy.body}</Text>
        {phase && !completed ? <Text style={styles.phase}>Secure step: {phase.replace(/_/gu, ' ')}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {completed ? (
          <TouchableOpacity style={styles.button} onPress={onDone} accessibilityRole="button">
            <Text style={styles.buttonText}>Continue to sign in</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.button, (!isConnected || isRetrying) && styles.disabled]}
            onPress={onRetry}
            disabled={!isConnected || isRetrying}
            accessibilityRole="button"
          >
            {isRetrying ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.buttonText}>Check again</Text>}
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background, justifyContent: 'center', padding: SPACING.lg },
  card: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: SPACING.xl, alignItems: 'center' },
  title: { marginTop: SPACING.md, color: COLORS.textPrimary, fontSize: 22, fontWeight: FONT_WEIGHT.bold, textAlign: 'center' },
  body: { marginTop: SPACING.sm, color: COLORS.textSecondary, fontSize: 16, lineHeight: 23, textAlign: 'center' },
  phase: { marginTop: SPACING.md, color: COLORS.textMuted, fontSize: 13, textTransform: 'capitalize' },
  error: { marginTop: SPACING.md, color: COLORS.error, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  button: { marginTop: SPACING.lg, minWidth: 190, minHeight: 48, borderRadius: RADIUS.md, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.lg },
  buttonText: { color: COLORS.white, fontSize: 16, fontWeight: FONT_WEIGHT.semibold },
  disabled: { opacity: 0.5 },
});
