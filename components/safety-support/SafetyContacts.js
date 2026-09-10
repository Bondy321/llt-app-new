import { View } from 'react-native';
import { COLORS } from '../../theme';
import { ContactButton } from './SafetySupportComponents';

export default function SafetyContacts({ style, isDriver, tourData, emergencyNumber, operationsNumber,
  confirmEmergencyCall, openDialer, requestingDriverCall, handleRequestDriverCall }) {
  return (
    <View style={style}>
      <ContactButton icon="hospital-box" label="Emergency" sublabel={emergencyNumber}
        onPress={confirmEmergencyCall} color={COLORS.error} />
      <ContactButton icon="headset" label="Operations" sublabel={operationsNumber}
        onPress={() => openDialer(operationsNumber)} color={COLORS.primary} />
      {!isDriver ? (
        <ContactButton icon="phone-in-talk" label="Driver"
          sublabel={requestingDriverCall ? 'Requesting...' : 'Request callback'}
          onPress={handleRequestDriverCall} color={COLORS.accent} />
      ) : null}
      {!isDriver && tourData?.driverPhone ? (
        <ContactButton icon="phone" label="Call driver" sublabel={tourData.driverName || 'Assigned driver'}
          onPress={() => openDialer(tourData.driverPhone)} color={COLORS.primary} />
      ) : null}
    </View>
  );
}
