import { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { getMarketingNotificationDetail } from '../services/notifications/notificationDeviceApiService';

export default function MarketingNotificationDetailScreen({ broadcastId, categoryKey, onBack }) {
  const [state, setState] = useState({ loading: true, detail: null, error: null });
  useEffect(() => {
    let active = true;
    getMarketingNotificationDetail({ broadcastId, categoryKey })
      .then((result) => active && setState({ loading: false, detail: result.detail, error: null }))
      .catch((error) => active && setState({ loading: false, detail: null, error: error?.code || 'UNAVAILABLE' }));
    return () => { active = false; };
  }, [broadcastId, categoryKey]);
  return <SafeAreaView style={{ flex: 1, padding: 20 }}><ScrollView>
    <TouchableOpacity onPress={onBack} accessibilityRole="button"><Text>Back</Text></TouchableOpacity>
    {state.loading ? <ActivityIndicator /> : state.detail ? <View><Text style={{ fontSize: 24, fontWeight: '700' }}>{state.detail.title}</Text><Text style={{ marginTop: 12 }}>{state.detail.body}</Text></View> : <Text>This notification is no longer available.</Text>}
  </ScrollView></SafeAreaView>;
}
