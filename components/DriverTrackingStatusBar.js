import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { COLORS } from '../theme';

export default function DriverTrackingStatusBar({ tracking }) {
  if (!tracking?.active && !tracking?.pending && tracking?.state !== 'starting') return null;
  return <View style={styles.bar}>
    <Text style={styles.text} accessibilityLiveRegion="polite">{tracking.status}</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Stop coach tracking"
      style={styles.button} onPress={() => tracking.stop()}><Text style={styles.stop}>Stop</Text></TouchableOpacity>
  </View>;
}
const styles = StyleSheet.create({
  bar: { backgroundColor: COLORS.primary, flexDirection: 'row', alignItems: 'center', padding: 10, gap: 10 },
  text: { flex: 1, fontSize: 13, lineHeight: 19, color: COLORS.white },
  button: { paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#FFFFFF', borderRadius: 8 },
  stop: { color: COLORS.primary, fontWeight: '700' },
});
