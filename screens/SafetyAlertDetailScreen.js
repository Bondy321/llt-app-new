import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, SafeAreaView, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { getSafetyAlertDetail } from '../services/notifications/notificationDeviceApiService';

export default function SafetyAlertDetailScreen({ tourId, eventId, onBack }) {
  const [state, setState] = useState({ loading: true, alert: null, actionError: null, actionLoading: false });
  useEffect(() => {
    let active = true;
    getSafetyAlertDetail({ tourId, eventId }).then((result) => active && setState((current) => ({ ...current, loading: false, alert: result.alert }))).catch(() => active && setState((current) => ({ ...current, loading: false, alert: null })));
    return () => { active = false; };
  }, [eventId, tourId]);
  const updateStatus = async (action) => {
    setState((current) => ({ ...current, actionLoading: true, actionError: null }));
    try {
      const result = await getSafetyAlertDetail({ tourId, eventId, action });
      setState((current) => ({ ...current, alert: result.alert, actionLoading: false }));
    } catch (_error) {
      setState((current) => ({ ...current, actionLoading: false, actionError: 'The alert could not be updated. Please try again.' }));
    }
  };
  const confirmResolve = () => Alert.alert(
    'Resolve this safety alert?',
    'Only mark this resolved when the response is complete. This cannot be moved back to an earlier status.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mark resolved', style: 'destructive', onPress: () => updateStatus('resolve') },
    ],
  );
  return (
    <SafeAreaView style={{ flex: 1, padding: 20 }}>
      <ScrollView>
        <TouchableOpacity onPress={onBack} accessibilityRole="button"><Text>Back</Text></TouchableOpacity>
        {state.loading ? <ActivityIndicator /> : state.alert ? (
          <View>
            <Text style={{ fontSize: 24, fontWeight: '700' }}>Safety alert</Text>
            <Text style={{ marginTop: 12 }}>{state.alert.summary}</Text>
            <Text style={{ marginTop: 12 }}>Status: {state.alert.status}</Text>
            {state.actionError ? <Text accessibilityRole="alert" style={{ color: '#B91C1C', marginTop: 12 }}>{state.actionError}</Text> : null}
            {state.alert.resolved ? <Text style={{ marginTop: 16 }}>This alert has been resolved.</Text> : (
              <View style={{ gap: 12, marginTop: 20 }}>
                {state.alert.status !== 'acknowledged' && state.alert.status !== 'in_progress' ? (
                  <TouchableOpacity disabled={state.actionLoading} onPress={() => updateStatus('acknowledge')} accessibilityRole="button">
                    <Text>Acknowledge alert</Text>
                  </TouchableOpacity>
                ) : null}
                {state.alert.status !== 'in_progress' ? (
                  <TouchableOpacity disabled={state.actionLoading} onPress={() => updateStatus('start_response')} accessibilityRole="button">
                    <Text>Start response</Text>
                  </TouchableOpacity>
                ) : null}
                {state.alert.status !== 'escalated' ? (
                  <TouchableOpacity disabled={state.actionLoading} onPress={() => updateStatus('escalate')} accessibilityRole="button">
                    <Text>Escalate alert</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity disabled={state.actionLoading} onPress={confirmResolve} accessibilityRole="button">
                  <Text>Mark resolved</Text>
                </TouchableOpacity>
                {state.actionLoading ? <ActivityIndicator /> : null}
              </View>
            )}
          </View>
        ) : <Text>This safety alert is unavailable or you no longer have access.</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}
