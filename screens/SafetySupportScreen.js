// screens/SafetySupportScreen.js - Premium Safety & Emergency Support
import SafetySupportView from '../components/safety-support/SafetySupportView';
import createSafetyContactActions from '../services/safety-support/createSafetyContactActions';
import createSafetySosActions from '../services/safety-support/createSafetySosActions';
import createSafetyReportActions from '../services/safety-support/createSafetyReportActions';
import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Alert,
  Animated,
} from 'react-native';
import {
  SAFETY_CATEGORIES,
  CATEGORY_META,
  SEVERITY_LEVELS,
  updateLiveLocationSharing,
  processOfflineQueue,
} from '../services/safetyService';
import logger, { maskIdentifier } from '../services/loggerService';
import { resolveTourId } from '../services/tourIdentityService';

const SOS_COUNTDOWN_SECONDS = 5;
const EMPTY_QUEUE_SUMMARY = Object.freeze({
  total: 0,
  readyToRetry: 0,
  waiting: 0,
  requiresAttention: 0,
  nextRetryAtMs: null,
});

// ==================== SOS BUTTON COMPONENT ====================
export default function SafetySupportScreen({
  onBack,
  tourData,
  bookingData,
  userId,
  principalId,
  mode = 'passenger',
  isConnected = true,
}) {
  // Core state
  const [includeLocation, setIncludeLocation] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedSeverity, setSelectedSeverity] = useState(SEVERITY_LEVELS.MEDIUM);
  const [customMessage, setCustomMessage] = useState('');

  // SOS state
  const [sosActive, setSosActive] = useState(false);
  const [sosCountdown, setSosCountdown] = useState(SOS_COUNTDOWN_SECONDS);
  const sosTimerRef = useRef(null);
  const sosCountdownRef = useRef(SOS_COUNTDOWN_SECONDS);
  const sosCoordsRef = useRef(null);
  const [sosDeliveryState, setSosDeliveryState] = useState({ status: 'idle', message: '' });
  const mountedRef = useRef(true);
  const historyRequestSeqRef = useRef(0);

  // Live location state
  const [liveLocationSharing, setLiveLocationSharing] = useState(false);
  const [liveLocationUpdating, setLiveLocationUpdating] = useState(false);
  const [currentCoords, setCurrentCoords] = useState(null);
  const [locationAccuracy, setLocationAccuracy] = useState(null);
  const [liveLocationLastUpdate, setLiveLocationLastUpdate] = useState(null);
  const locationWatchRef = useRef(null);
  const liveLocationSharingRef = useRef(false);
  const activeLiveLocationScopeRef = useRef(null);

  useEffect(() => () => {
    mountedRef.current = false;
    historyRequestSeqRef.current += 1;
    if (sosTimerRef.current) {
      clearInterval(sosTimerRef.current);
      sosTimerRef.current = null;
    }
    if (locationWatchRef.current) {
      locationWatchRef.current.remove();
      locationWatchRef.current = null;
    }
    const activeScope = activeLiveLocationScopeRef.current;
    if (liveLocationSharingRef.current && activeScope?.tourId && activeScope?.userId) {
      updateLiveLocationSharing(activeScope.tourId, activeScope.userId, false).catch(() => {});
      liveLocationSharingRef.current = false;
      activeLiveLocationScopeRef.current = null;
    }
  }, []);

  // Contacts state
  const [trustedContacts, setTrustedContacts] = useState([]);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');
  const [contactSaving, setContactSaving] = useState(false);

  // Report modal state
  const [showReportModal, setShowReportModal] = useState(false);

  // History state
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [safetyHistory, setSafetyHistory] = useState([]);
  const [requestingDriverCall, setRequestingDriverCall] = useState(false);

  // Derived values
  const isDriver = mode === 'driver';
  const emergencyNumber = '999';
  const operationsNumber = '+441414876737';
  const tourId = resolveTourId(tourData?.id, tourData?.tourCode);
  const userName = bookingData?.passengerNames?.[0] || (isDriver ? tourData?.driverName : 'Passenger');
  const safetyQueueScope = useMemo(() => ({
    tourId,
    principalId: principalId || userId,
    role: mode === 'driver' ? 'driver' : 'passenger',
  }), [mode, principalId, tourId, userId]);

  const [loadingHistory, setLoadingHistory] = useState(false);

  // Tips expanded state
  const [tipsExpanded, setTipsExpanded] = useState(false);

  // Offline queue state
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [offlineQueueSummary, setOfflineQueueSummary] = useState(EMPTY_QUEUE_SUMMARY);
  const [syncingOfflineQueue, setSyncingOfflineQueue] = useState(false);

  // Animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;
  const checkOfflineQueueRef = useRef(null);
  const loadTrustedContactsRef = useRef(null);

  useEffect(() => {
    logger.trackScreen('SafetySupport', {
      tourId,
      mode,
      isConnected,
      userId: maskIdentifier(userId),
      hasTourData: Boolean(tourData),
      hasBookingData: Boolean(bookingData),
    });
  }, [bookingData, isConnected, mode, tourData, tourId, userId]);

  // Get visible categories based on mode
  const visibleCategories = useMemo(() => {
    return Object.keys(CATEGORY_META).filter((key) => {
      const meta = CATEGORY_META[key];
      if (key === SAFETY_CATEGORIES.SOS) return false; // SOS is handled separately
      if (meta.driverOnly && !isDriver) return false;
      return true;
    });
  }, [isDriver]);

  // Entry animation
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  const safetyPrincipalId = principalId || userId;

  // Load trusted contacts
  useEffect(() => {
    loadTrustedContactsRef.current?.();
  }, [safetyPrincipalId]);

  useEffect(() => {
    checkOfflineQueueRef.current?.();
  }, [safetyQueueScope]);

  // Process offline queue when connected
  useEffect(() => {
    if (isConnected && offlineQueueSummary.readyToRetry > 0 && !syncingOfflineQueue) {
      setSyncingOfflineQueue(true);
      logger.info('SafetySupportScreen', 'Processing offline safety queue after reconnect', {
        userId: maskIdentifier(userId),
        offlineQueueCount: offlineQueueSummary.total,
      });
      processOfflineQueue(safetyQueueScope).then(async ({ processed, failed, requiresAttention }) => {
        if (!mountedRef.current) return;
        logger.info('SafetySupportScreen', 'Offline safety queue processed', {
          userId: maskIdentifier(userId),
          processed,
          failed,
          requiresAttention,
        });
        if (processed > 0) {
          Alert.alert(
            'Reports Synced',
            `${processed} pending safety report(s) have been submitted.`
          );
        }
        await checkOfflineQueueRef.current?.();
      }).catch((error) => {
        logger.error('SafetySupportScreen', 'Offline safety queue processing failed', {
          userId: maskIdentifier(userId),
          error: error?.message || String(error),
        });
      }).finally(() => {
        if (mountedRef.current) setSyncingOfflineQueue(false);
      });
    }
  }, [isConnected, offlineQueueSummary.readyToRetry, offlineQueueSummary.total, safetyQueueScope, syncingOfflineQueue, userId]);

  useEffect(() => {
    if (!isConnected || !offlineQueueSummary.nextRetryAtMs) return undefined;
    const delay = Math.max(0, offlineQueueSummary.nextRetryAtMs - Date.now());
    const timer = setTimeout(() => {
      checkOfflineQueueRef.current?.();
    }, Math.min(delay + 50, 15 * 60 * 1000));
    return () => clearTimeout(timer);
  }, [isConnected, offlineQueueSummary.nextRetryAtMs, safetyQueueScope]);

  const { loadTrustedContacts, checkOfflineQueue, handleRetrySafetyQueue, openDialer, confirmEmergencyCall, handleRequestDriverCall, sendSMS } = createSafetyContactActions({ emergencyNumber, isConnected, mode, mountedRef, principalId, requestingDriverCall, safetyPrincipalId, safetyQueueScope, setOfflineQueueCount, setOfflineQueueSummary, setRequestingDriverCall, setSyncingOfflineQueue, setTrustedContacts, syncingOfflineQueue, tourId, userId });

  const { startSOS, confirmAccessibleSOS, cancelSOS, toggleLiveLocation } = createSafetySosActions({ activeLiveLocationScopeRef, bookingData, checkOfflineQueue, confirmEmergencyCall, currentCoords, emergencyNumber, includeLocation, isConnected, liveLocationSharingRef, liveLocationUpdating, locationWatchRef, mode, mountedRef, openDialer, operationsNumber, principalId, sendSMS, setCurrentCoords, setLiveLocationLastUpdate, setLiveLocationSharing, setLiveLocationUpdating, setLocationAccuracy, setSosActive, setSosCountdown, setSosDeliveryState, sosActive, sosCoordsRef, sosCountdownRef, sosTimerRef, tourData, tourId, trustedContacts, userId, userName });

  const { handleSelectCategory, handleSubmitReport, handleAddContact, handleRemoveContact, loadHistory } = createSafetyReportActions({ bookingData, contactSaving, customMessage, historyRequestSeqRef, includeLocation, isConnected, loadTrustedContacts, mode, mountedRef, newContactName, newContactPhone, principalId, safetyPrincipalId, safetyQueueScope, selectedCategory, selectedSeverity, setContactSaving, setCustomMessage, setLoadingHistory, setNewContactName, setNewContactPhone, setSafetyHistory, setSelectedCategory, setSelectedSeverity, setShowAddContactModal, setShowHistoryModal, setShowReportModal, setSubmitting, submitting, tourId, userId });

  checkOfflineQueueRef.current = checkOfflineQueue;
  loadTrustedContactsRef.current = loadTrustedContacts;

  return <SafetySupportView {...{ cancelSOS, confirmAccessibleSOS, confirmEmergencyCall, contactSaving, customMessage, emergencyNumber, fadeAnim, handleAddContact, handleRemoveContact, handleRequestDriverCall, handleRetrySafetyQueue, handleSelectCategory, handleSubmitReport, includeLocation, isConnected, isDriver, liveLocationLastUpdate, liveLocationSharing, liveLocationUpdating, loadHistory, loadingHistory, locationAccuracy, mode, newContactName, newContactPhone, offlineQueueCount, offlineQueueSummary, onBack, openDialer, operationsNumber, requestingDriverCall, safetyHistory, selectedCategory, selectedSeverity, setCustomMessage, setIncludeLocation, setNewContactName, setNewContactPhone, setSelectedSeverity, setShowAddContactModal, setShowHistoryModal, setShowReportModal, setTipsExpanded, showAddContactModal, showHistoryModal, showReportModal, slideAnim, sosActive, sosCountdown, sosDeliveryState, startSOS, submitting, syncingOfflineQueue, tipsExpanded, toggleLiveLocation, tourData, tourId, trustedContacts, visibleCategories }} />;
}

// ==================== STYLES ====================
