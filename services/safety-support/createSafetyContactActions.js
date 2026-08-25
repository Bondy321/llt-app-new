// screens/SafetySupportScreen.js - Premium Safety & Emergency Support
import {
  Linking,
  Alert,
} from 'react-native';
import {
  logSafetyEvent,
  SAFETY_CATEGORIES,
  SEVERITY_LEVELS,
  getTrustedContacts,
  processOfflineQueue,
  getOfflineQueueSummary,
} from '../safetyService';
import logger, { maskIdentifier } from '../loggerService';

const MIN_DIALABLE_DIGITS = 7;
const hasDialableDigits = (phone) => (
  (String(phone || '').match(/\d/g) || []).length >= MIN_DIALABLE_DIGITS
);

// ==================== SOS BUTTON COMPONENT ====================

export default function createSafetyContactActions(context) {
  const { emergencyNumber, isConnected, mode, mountedRef, principalId, requestingDriverCall, safetyPrincipalId, safetyQueueScope, setOfflineQueueCount, setOfflineQueueSummary, setRequestingDriverCall, setSyncingOfflineQueue, setTrustedContacts, syncingOfflineQueue, tourId, userId } = context;
  const loadTrustedContacts = async () => {
    logger.debug('SafetySupportScreen', 'Trusted contacts load started');
    const contacts = await getTrustedContacts(safetyPrincipalId);
    if (!mountedRef.current) return;
    setTrustedContacts(contacts);
    logger.info('SafetySupportScreen', 'Trusted contacts loaded', { contactCount: contacts.length });
  };

  const checkOfflineQueue = async () => {
    const summary = await getOfflineQueueSummary(safetyQueueScope);
    if (!mountedRef.current) return;
    setOfflineQueueCount(summary.total);
    setOfflineQueueSummary(summary);
    logger.info('SafetySupportScreen', 'Offline safety queue summary loaded', {
      count: summary.total,
      readyToRetry: summary.readyToRetry,
      requiresAttention: summary.requiresAttention,
    });
  };

  const handleRetrySafetyQueue = async () => {
    if (!isConnected || syncingOfflineQueue) return;
    setSyncingOfflineQueue(true);
    try {
      const result = await processOfflineQueue(safetyQueueScope, { manual: true });
      await checkOfflineQueue();
      if (!mountedRef.current) return;
      if (result.processed > 0) {
        Alert.alert('Saved reports sent', `${result.processed} safety report(s) were submitted.`);
      } else if (result.requiresAttention > 0 || result.failed > 0) {
        Alert.alert(
          'Report still needs attention',
          'The saved report could not be accepted. Check that this tour session is current, or call operations if the issue is urgent.',
        );
      }
    } finally {
      if (mountedRef.current) setSyncingOfflineQueue(false);
    }
  };

  const openDialer = async (phone) => {
    if (!phone) {
      logger.warn('SafetySupportScreen', 'Dialer blocked without phone', { mode, tourId });
      Alert.alert('Contact unavailable', 'No phone number is configured for this tour.');
      return;
    }
    const sanitized = phone.replace(/[^+\d]/g, '');
    if (!sanitized || !hasDialableDigits(sanitized)) {
      logger.warn('SafetySupportScreen', 'Dialer blocked with invalid phone', { mode, tourId });
      Alert.alert('Contact unavailable', 'No valid phone number is configured for this tour.');
      return;
    }
    logger.info('SafetySupportScreen', 'Dialer opened', {
      mode,
      tourId,
      phoneLength: sanitized.length,
    });
    try {
      await Linking.openURL(`tel:${sanitized}`);
    } catch (error) {
      logger.warn('SafetySupportScreen', 'Dialer launch failed', {
        mode,
        tourId,
        phoneLength: sanitized.length,
        error: error?.message || String(error),
      });
      Alert.alert('Could not open phone app', `Please dial ${sanitized} manually if this is urgent.`);
    }
  };

  const confirmEmergencyCall = () => {
    logger.warn('SafetySupportScreen', 'Emergency call confirmation opened', {
      mode,
      tourId,
      userId: maskIdentifier(userId),
    });
    Alert.alert(
      'Call emergency services?',
      'Only continue for an extreme emergency requiring immediate police, fire, or ambulance response.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Call ${emergencyNumber}`,
          style: 'destructive',
          onPress: () => openDialer(emergencyNumber),
        },
      ]
    );
  };

  const handleRequestDriverCall = async () => {
    if (requestingDriverCall) return;
    if (!tourId) {
      logger.warn('SafetySupportScreen', 'Driver callback request blocked without tour id', {
        userId: maskIdentifier(userId),
      });
      Alert.alert('Unavailable', 'We could not find your tour right now. Please contact operations.');
      return;
    }

    setRequestingDriverCall(true);
    logger.info('SafetySupportScreen', 'Driver callback request started', {
      tourId,
      userId: maskIdentifier(userId),
      isConnected,
    });
    let result;
    try {
      result = await logSafetyEvent({
        userId,
        principalId: principalId || userId,
        tourId,
        role: 'passenger',
        category: SAFETY_CATEGORIES.CUSTOM,
        severity: SEVERITY_LEVELS.MEDIUM,
        message: 'Driver callback requested',
        customMessage: 'A passenger requested a callback from the assigned driver.',
        online: isConnected,
      });
    } catch (error) {
      result = { success: false, error: error?.code || error?.message || 'unknown' };
    }
    if (!mountedRef.current) return;
    setRequestingDriverCall(false);

    if (result?.success) {
      logger.info('SafetySupportScreen', 'Driver callback request sent', {
        tourId,
        queued: Boolean(result.queued),
      });
      Alert.alert(
        result.queued ? 'Callback request saved' : 'Callback requested',
        result.queued
          ? 'Your request is stored on this device and will be sent to the driver team when you reconnect.'
          : 'Your request was securely received for the assigned driver team. Please keep your phone nearby.'
      );
      return;
    }

    logger.warn('SafetySupportScreen', 'Driver callback request failed', {
      tourId,
      error: result?.error || 'unknown',
    });
    Alert.alert(
      'Could not send request',
      'Please try again, or contact operations directly if this is urgent.'
    );
  };

  const sendSMS = async (phone, message) => {
    const sanitized = typeof phone === 'string' ? phone.replace(/[^+\d]/g, '') : '';
    if (!sanitized || !hasDialableDigits(sanitized)) {
      logger.warn('SafetySupportScreen', 'Emergency SMS blocked with invalid phone', { tourId });
      Alert.alert('Contact unavailable', 'No valid SMS number is available for this contact.');
      return;
    }

    const encoded = encodeURIComponent(message);
    logger.info('SafetySupportScreen', 'Emergency SMS compose opened', {
      tourId,
      phoneLength: sanitized.length,
      messageLength: message?.length || 0,
    });
    try {
      await Linking.openURL(`sms:${sanitized}?body=${encoded}`);
    } catch (error) {
      logger.warn('SafetySupportScreen', 'Emergency SMS launch failed', {
        tourId,
        phoneLength: sanitized.length,
        error: error?.message || String(error),
      });
      Alert.alert('Could not open messages', 'Please try again, or contact this person manually if it is urgent.');
    }
  };

  // ==================== SOS HANDLERS ====================

  return { loadTrustedContacts, checkOfflineQueue, handleRetrySafetyQueue, openDialer, confirmEmergencyCall, handleRequestDriverCall, sendSMS };
}
