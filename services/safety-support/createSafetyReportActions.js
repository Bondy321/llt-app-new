// screens/SafetySupportScreen.js - Premium Safety & Emergency Support
import {
  Alert,
  Platform,
} from 'react-native';
import * as Location from 'expo-location';
import * as Haptics from '../hapticsService';
import {
  logSafetyEvent,
  CATEGORY_META,
  SEVERITY_LEVELS,
  addTrustedContact,
  removeTrustedContact,
  getSafetyHistory,
  getOfflineQueuedSafetyEvents,
} from '../safetyService';
import logger, { maskIdentifier } from '../loggerService';
import { parseTimestampMs } from '../timeUtils';

const MIN_DIALABLE_DIGITS = 7;
const hasDialableDigits = (phone) => (
  (String(phone || '').match(/\d/g) || []).length >= MIN_DIALABLE_DIGITS
);

const getSafetyEventTimestampMs = (event) => {
  const parsed = parseTimestampMs(event?.timestamp || event?.queuedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

// ==================== SOS BUTTON COMPONENT ====================

export default function createSafetyReportActions(context) {
  const { bookingData, contactSaving, customMessage, historyRequestSeqRef, includeLocation, isConnected, loadTrustedContacts, mode, mountedRef, newContactName, newContactPhone, principalId, safetyPrincipalId, safetyQueueScope, selectedCategory, selectedSeverity, setContactSaving, setCustomMessage, setLoadingHistory, setNewContactName, setNewContactPhone, setSafetyHistory, setSelectedCategory, setSelectedSeverity, setShowAddContactModal, setShowHistoryModal, setShowReportModal, setSubmitting, submitting, tourId, userId } = context;
  const handleSelectCategory = (category) => {
    logger.info('SafetySupportScreen', 'Safety category selected', {
      tourId,
      category,
      mode,
    });
    setSelectedCategory(category);
    setShowReportModal(true);
  };

  const handleSubmitReport = async () => {
    if (!selectedCategory || submitting) return;

    setSubmitting(true);
    logger.info('SafetySupportScreen', 'Safety report submit started', {
      tourId,
      category: selectedCategory,
      severity: selectedSeverity,
      includeLocation,
      isConnected,
      messageLength: customMessage.trim().length,
    });

    try {
      let coords = null;

      if (includeLocation) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const location = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          if (!mountedRef.current) return;
          coords = location.coords;
          logger.info('SafetySupportScreen', 'Safety report location captured', {
            tourId,
            accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
          });
        } else {
          logger.warn('SafetySupportScreen', 'Safety report location permission denied', {
            tourId,
            status,
          });
        }
      }

      const meta = CATEGORY_META[selectedCategory];

      const submission = await logSafetyEvent({
        userId,
        principalId: principalId || userId,
        bookingId: bookingData?.id,
        tourId,
        role: mode,
        category: selectedCategory,
        severity: selectedSeverity,
        message: meta?.description || 'Safety report',
        customMessage: customMessage.trim() || null,
        coords,
        online: isConnected,
      });
      if (!mountedRef.current) return;
      logger.info('SafetySupportScreen', submission.queued ? 'Safety report queued' : 'Safety report submitted', {
        tourId,
        category: selectedCategory,
        severity: selectedSeverity,
        includedLocation: Boolean(coords),
        queued: Boolean(submission.queued),
      });

      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      Alert.alert(
        submission.queued ? 'Report Saved for Retry' : 'Report Submitted',
        submission.queued
          ? 'Your report is safely stored on this device and will be submitted when the connection is available.'
          : 'Your report was securely received. Operations and the assigned driver team can now review it.',
        [{
          text: 'OK',
          onPress: () => {
            setShowReportModal(false);
            setSelectedCategory(null);
            setSelectedSeverity(SEVERITY_LEVELS.MEDIUM);
            setCustomMessage('');
          },
        }]
      );
    } catch (error) {
      if (!mountedRef.current) return;
      logger.error('SafetySupportScreen', 'Safety report was not submitted or stored', {
        tourId,
        category: selectedCategory,
        severity: selectedSeverity,
        isConnected,
        code: error?.code || null,
        error: error?.message || String(error),
      });
      if (mountedRef.current) {
        Alert.alert(
          'Report Not Saved',
          'The report could not be submitted or stored on this device. Please try again or call operations directly.'
        );
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  // ==================== CONTACT HANDLERS ====================
  const handleAddContact = async () => {
    if (contactSaving) return;
    if (!newContactName.trim() || !newContactPhone.trim()) {
      logger.warn('SafetySupportScreen', 'Trusted contact add blocked by missing fields', {
        hasName: Boolean(newContactName.trim()),
        hasPhone: Boolean(newContactPhone.trim()),
      });
      Alert.alert('Required', 'Please enter both name and phone number.');
      return;
    }
    if (!hasDialableDigits(newContactPhone)) {
      logger.warn('SafetySupportScreen', 'Trusted contact add blocked by invalid phone', {
        phoneLength: newContactPhone.replace(/[^+\d]/g, '').length,
      });
      Alert.alert('Invalid phone number', 'Please enter a valid phone number including area or country code.');
      return;
    }

    setContactSaving(true);
    logger.info('SafetySupportScreen', 'Trusted contact add started', {
      nameLength: newContactName.trim().length,
      phoneLength: newContactPhone.replace(/[^+\d]/g, '').length,
    });
    try {
      await addTrustedContact(safetyPrincipalId, {
        name: newContactName.trim(),
        phone: newContactPhone.trim(),
      });
      await loadTrustedContacts();
      if (!mountedRef.current) return;
      setShowAddContactModal(false);
      setNewContactName('');
      setNewContactPhone('');
      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      logger.info('SafetySupportScreen', 'Trusted contact add completed');
    } catch (error) {
      if (!mountedRef.current) return;
      logger.warn('SafetySupportScreen', 'Trusted contact add failed', {
        code: error?.code || null,
        error: error?.message || String(error),
      });
      Alert.alert(
        error?.code === 'TRUSTED_CONTACT_LIMIT' ? 'Contact limit reached' : 'Contact not saved',
        error?.code === 'TRUSTED_CONTACT_LIMIT'
          ? error.message
          : 'This contact could not be stored safely on this device. Please try again.',
      );
    } finally {
      if (mountedRef.current) setContactSaving(false);
    }
  };

  const handleRemoveContact = async (contactId) => {
    logger.info('SafetySupportScreen', 'Trusted contact remove confirmation opened', {
      contactId: maskIdentifier(contactId),
    });
    Alert.alert(
      'Remove Contact',
      'Are you sure you want to remove this emergency contact?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeTrustedContact(safetyPrincipalId, contactId);
              await loadTrustedContacts();
              if (!mountedRef.current) return;
              logger.info('SafetySupportScreen', 'Trusted contact removed', {
                contactId: maskIdentifier(contactId),
              });
            } catch (error) {
              if (!mountedRef.current) return;
              logger.warn('SafetySupportScreen', 'Trusted contact removal failed', {
                contactId: maskIdentifier(contactId),
                error: error?.message || String(error),
              });
              Alert.alert('Contact not removed', 'The change could not be stored on this device. Please try again.');
            }
          },
        },
      ]
    );
  };

  // ==================== HISTORY HANDLERS ====================
  const loadHistory = async () => {
    const requestSeq = ++historyRequestSeqRef.current;
    setLoadingHistory(true);
    logger.info('SafetySupportScreen', 'Safety history load started', {
      userId: maskIdentifier(userId),
    });
    try {
      const [history, queuedEvents] = await Promise.all([
        getSafetyHistory(userId),
        getOfflineQueuedSafetyEvents(safetyQueueScope),
      ]);
      if (!mountedRef.current || requestSeq !== historyRequestSeqRef.current) return;

      const mergedHistory = [...queuedEvents, ...history].sort(
        (a, b) => getSafetyEventTimestampMs(b) - getSafetyEventTimestampMs(a)
      );

      setSafetyHistory(mergedHistory);
      setShowHistoryModal(true);
      logger.info('SafetySupportScreen', 'Safety history load completed', {
        userId: maskIdentifier(userId),
        remoteCount: history.length,
        queuedCount: queuedEvents.length,
        mergedCount: mergedHistory.length,
      });
    } catch (error) {
      logger.warn('SafetySupportScreen', 'Safety history load failed', {
        userId: maskIdentifier(userId),
        error: error?.message || String(error),
      });
      if (mountedRef.current && requestSeq === historyRequestSeqRef.current) {
        Alert.alert('History unavailable', 'Could not load safety history right now. Please try again.');
      }
    } finally {
      if (mountedRef.current && requestSeq === historyRequestSeqRef.current) {
        setLoadingHistory(false);
      }
    }
  };

  // ==================== RENDER ====================

  return { handleSelectCategory, handleSubmitReport, handleAddContact, handleRemoveContact, loadHistory };
}
