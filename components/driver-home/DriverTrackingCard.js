import { useState } from 'react';
import { Modal, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { COLORS } from '../../theme';

export default function DriverTrackingCard({ tracking }) {
  const [explaining, setExplaining] = useState(false);
  const busy = tracking?.state === 'starting' || tracking?.pending;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Coach tracking</Text>
      <Text style={styles.description}>Start a tracking session to share this tour’s coach while your phone is locked or you use another app.</Text>
      <Text accessibilityLiveRegion="polite" style={styles.status}>{tracking?.status || 'Tracking is unavailable until your driver session is ready.'}</Text>
      {tracking?.lastPublishedAtMs ? <Text style={styles.description}>Last shared: {new Date(tracking.lastPublishedAtMs).toLocaleTimeString()}</Text> : null}
      {tracking?.active || busy ? (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={tracking?.pending ? 'Retry stopping coach tracking' : 'Stop coach tracking'}
          onPress={() => tracking.stop()} style={styles.stop}>
          <Text style={styles.buttonText}>{tracking?.pending ? 'Retry stop' : 'Stop tracking'}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Start coach tracking"
          disabled={!tracking?.canStart} onPress={() => setExplaining(true)}
          style={[styles.start, !tracking?.canStart && styles.disabled]}>
          <Text style={styles.buttonText}>Start tracking</Text>
        </TouchableOpacity>
      )}
      <Text style={styles.description}>Stop tracking when your journey is finished. If you force-close LLT, reopen it and start a new session.</Text>
      <Modal visible={explaining} transparent animationType="fade" onRequestClose={() => setExplaining(false)}>
        <View style={styles.overlay}><View style={styles.dialog}>
          <Text style={styles.title}>Share your coach’s location</Text>
          <Text style={styles.description}>LLT collects your phone’s location to show this tour’s coach to passengers and the Loch Lomond Travel office, even when the app is in the background or your phone is locked.</Text>
          <Text style={styles.description}>Sharing begins only when you continue and grant location access. You can stop at any time in LLT. Signing out, changing tour or losing your driver session stops tracking. A fixed pickup pin is kept separately.</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Continue to tracking permissions"
            style={styles.start} onPress={() => { setExplaining(false); tracking.start(); }}>
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" style={styles.cancel} onPress={() => setExplaining(false)}><Text>Not now</Text></TouchableOpacity>
        </View></View>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.white, borderRadius: 16, padding: 16, marginBottom: 18, gap: 10 },
  title: { fontSize: 18, fontWeight: '700', color: COLORS.textPrimary },
  description: { fontSize: 14, lineHeight: 21, color: COLORS.textSecondary },
  status: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: COLORS.textPrimary },
  start: { backgroundColor: COLORS.primary, borderRadius: 10, padding: 14, alignItems: 'center' },
  stop: { backgroundColor: COLORS.error, borderRadius: 10, padding: 14, alignItems: 'center' },
  disabled: { opacity: 0.45 }, buttonText: { color: COLORS.white, fontWeight: '700' },
  overlay: { flex: 1, backgroundColor: '#0008', padding: 24, justifyContent: 'center' },
  dialog: { backgroundColor: COLORS.white, padding: 22, borderRadius: 18, gap: 14 },
  cancel: { padding: 12, alignItems: 'center' },
});
