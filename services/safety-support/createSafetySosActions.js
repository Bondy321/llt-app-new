// screens/SafetySupportScreen.js - Premium Safety & Emergency Support
import { useEffect } from 'react';
import {
  Alert,
  Platform,
  Vibration,
} from 'react-native';
import * as Location from 'expo-location';
import * as Haptics from '../hapticsService';
import {
  logSafetyEvent,
  SAFETY_CATEGORIES,
  SEVERITY_LEVELS,
  updateLiveLocationSharing,
  generateEmergencySMS,
} from '../safetyService';
import logger, { maskIdentifier } from '../loggerService';

const SOS_COUNTDOWN_SECONDS = 5;
const MIN_DIALABLE_DIGITS = 7;
const hasDialableDigits = (phone) => (
  (String(phone || '').match(/\d/g) || []).length >= MIN_DIALABLE_DIGITS
);

// ==================== SOS BUTTON COMPONENT ====================

export default function createSafetySosActions(context) {
  const { activeLiveLocationScopeRef, bookingData, checkOfflineQueue, confirmEmergencyCall, currentCoords, emergencyNumber, includeLocation, isConnected, liveLocationSharingRef, liveLocationUpdating, locationWatchRef, mode, mountedRef, openDialer, operationsNumber, principalId, sendSMS, setCurrentCoords, setLiveLocationLastUpdate, setLiveLocationSharing, setLiveLocationUpdating, setLocationAccuracy, setSosActive, setSosCountdown, setSosDeliveryState, sosActive, sosCoordsRef, sosCountdownRef, sosTimerRef, tourData, tourId, trustedContacts, userId, userName } = context;
  const startSOS = async () => {
    if (sosActive) return;
    logger.warn('SafetySupportScreen', 'SOS countdown activated', {
      mode,
      tourId,
      userId: maskIdentifier(userId),
      includeLocation,
    });
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    Vibration.vibrate([0, 200, 100, 200]);

    setSosActive(true);
    setSosCountdown(SOS_COUNTDOWN_SECONDS);
    sosCountdownRef.current = SOS_COUNTDOWN_SECONDS;
    sosCoordsRef.current = currentCoords;

    if (sosTimerRef.current) clearInterval(sosTimerRef.current);
    sosTimerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      sosCountdownRef.current = Math.max(0, sosCountdownRef.current - 1);
      setSosCountdown(sosCountdownRef.current);
      if (sosCountdownRef.current === 0) {
        clearInterval(sosTimerRef.current);
        sosTimerRef.current = null;
        executeSOS(sosCoordsRef.current);
        return;
      }
      Vibration.vibrate(100);
    }, 1000);

    // Capture location in parallel so emergency call options never wait on GPS.
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        if (!mountedRef.current) return;
        sosCoordsRef.current = location.coords;
        setCurrentCoords(location.coords);
        setLocationAccuracy(location.coords.accuracy);
        logger.info('SafetySupportScreen', 'SOS location captured', {
          tourId,
          accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
        });
      } else {
        logger.warn('SafetySupportScreen', 'SOS location permission denied', { tourId, status });
      }
    } catch (error) {
      logger.warn('SafetySupportScreen', 'SOS location capture failed', {
        tourId,
        error: error?.message || String(error),
      });
    }
  };

  const confirmAccessibleSOS = () => {
    if (sosActive) {
      cancelSOS();
      return;
    }
    Alert.alert(
      'Start SOS countdown?',
      `Emergency options will open after ${SOS_COUNTDOWN_SECONDS} seconds. The app will not call ${emergencyNumber} automatically.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start countdown', style: 'destructive', onPress: startSOS },
      ],
    );
  };

  const cancelSOS = () => {
    logger.info('SafetySupportScreen', 'SOS countdown cancelled', {
      tourId,
      userId: maskIdentifier(userId),
    });
    if (sosTimerRef.current) {
      clearInterval(sosTimerRef.current);
      sosTimerRef.current = null;
    }
    sosCoordsRef.current = null;
    setSosActive(false);
    setSosCountdown(SOS_COUNTDOWN_SECONDS);
    sosCountdownRef.current = SOS_COUNTDOWN_SECONDS;
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const executeSOS = (capturedCoords = null) => {
    if (!mountedRef.current) return;
    setSosActive(false);
    logger.warn('SafetySupportScreen', 'SOS countdown completed', {
      tourId,
      userId: maskIdentifier(userId),
      hasLocation: Boolean(capturedCoords),
      trustedContactCount: trustedContacts.length,
    });

    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
    Vibration.vibrate([0, 500, 200, 500]);

    const canNotifyPrimaryContact = trustedContacts.length > 0
      && hasDialableDigits(trustedContacts[0]?.phone);
    const primaryContact = canNotifyPrimaryContact ? trustedContacts[0] : null;
    const smsMessage = primaryContact
      ? generateEmergencySMS(capturedCoords, tourData, userName)
      : null;
    const emergencyActions = [
      {
        text: `Call ${emergencyNumber}`,
        style: 'destructive',
        onPress: () => confirmEmergencyCall(),
      },
      {
        text: 'Call Operations',
        onPress: () => openDialer(operationsNumber),
      },
    ];

    if (primaryContact) {
      emergencyActions.push({
        text: `Text ${primaryContact.name}`,
        onPress: () => sendSMS(primaryContact.phone, smsMessage),
      });
    }
    emergencyActions.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert(
      'Emergency options',
      `This app does not notify emergency services for you. If you need urgent help, call ${emergencyNumber} now.`,
      emergencyActions
    );

    // Recording and alert fanout run after options are shown. A slow or failed
    // network must never delay access to the phone dialler.
    setSosDeliveryState({
      status: 'sending',
      message: 'Sending an operations safety alert…',
    });
    logSafetyEvent({
        userId,
        principalId: principalId || userId,
        bookingId: bookingData?.id,
        tourId,
        role: mode,
        category: SAFETY_CATEGORIES.SOS,
        severity: SEVERITY_LEVELS.CRITICAL,
        message: 'SOS quick action opened by user (no emergency dispatch performed)',
        coords: capturedCoords,
        isSOS: true,
        online: isConnected,
      }).then((sosSubmission) => {
      logger.info('SafetySupportScreen', sosSubmission.queued ? 'SOS safety event queued' : 'SOS safety event logged', {
        tourId,
        userId: maskIdentifier(userId),
        hasLocation: Boolean(capturedCoords),
        queued: Boolean(sosSubmission.queued),
      });
      if (mountedRef.current) {
        setSosDeliveryState(sosSubmission.queued
          ? {
              status: 'queued',
              message: 'Operations alert saved on this device. It will send automatically when a connection is available.',
            }
          : {
              status: 'submitted',
              message: 'Operations safety alert sent.',
            });
        checkOfflineQueue();
      }
    }).catch((error) => {
      logger.error('SafetySupportScreen', 'SOS safety event log failed', {
        tourId,
        userId: maskIdentifier(userId),
        error: error?.message || String(error),
      });
      if (mountedRef.current) {
        setSosDeliveryState({
          status: 'failed',
          message: 'The operations alert was not saved. Use the call options now if you still need help.',
        });
      }
    });
  };

  // ==================== LIVE LOCATION HANDLERS ====================
  const toggleLiveLocation = async (enabled) => {
    if (liveLocationUpdating) return;
    const targetScope = enabled
      ? { tourId, userId }
      : (activeLiveLocationScopeRef.current || { tourId, userId });
    logger.info('SafetySupportScreen', 'Live location toggle requested', {
      tourId,
      userId: maskIdentifier(userId),
      enabled,
    });
    if (!targetScope.tourId || !targetScope.userId) {
      logger.warn('SafetySupportScreen', 'Live location toggle blocked without identity context', {
        hasTourId: Boolean(tourId),
        hasUserId: Boolean(userId),
      });
      Alert.alert('Location sharing unavailable', 'We could not identify this tour session. Please reconnect or contact operations.');
      return;
    }
    setLiveLocationUpdating(true);

    if (enabled) {
      try {
        if (locationWatchRef.current) {
          locationWatchRef.current.remove();
          locationWatchRef.current = null;
        }

        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!mountedRef.current) return;
        if (status !== 'granted') {
          logger.warn('SafetySupportScreen', 'Live location permission denied', { tourId, status });
          Alert.alert('Permission Denied', 'Location permission is required for live sharing.');
          setLiveLocationUpdating(false);
          return;
        }

        // Get initial position
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        if (!mountedRef.current) return;
        setCurrentCoords(location.coords);
        setLocationAccuracy(location.coords.accuracy);

        // Start watching
        locationWatchRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 10000, // Update every 10 seconds
            distanceInterval: 20, // Or when moved 20 meters
          },
          (location) => {
            if (!mountedRef.current) return;
            setCurrentCoords(location.coords);
            setLocationAccuracy(location.coords.accuracy);
            updateLiveLocationSharing(
              tourId,
              userId,
              true,
              location.coords
            ).then((success) => {
              if (!success) {
                logger.warn('SafetySupportScreen', 'Live location watch update was not accepted', {
                  tourId,
                  userId: maskIdentifier(userId),
                });
              } else if (mountedRef.current) {
                setLiveLocationLastUpdate(Date.now());
              }
            }).catch((error) => {
              logger.warn('SafetySupportScreen', 'Live location watch update failed', {
                tourId,
                userId: maskIdentifier(userId),
                error: error?.message || String(error),
              });
            });
            logger.debug('SafetySupportScreen', 'Live location watch update sent', {
              tourId,
              userId: maskIdentifier(userId),
              accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
            });
          }
        );

        // Initial update
        const shareStarted = await updateLiveLocationSharing(
          tourId,
          userId,
          true,
          location.coords
        );
        if (!mountedRef.current) return;
        if (!shareStarted) {
          throw new Error('Live location update was not accepted');
        }

        setLiveLocationSharing(true);
        liveLocationSharingRef.current = true;
        activeLiveLocationScopeRef.current = { tourId, userId };
        setLiveLocationLastUpdate(Date.now());
        logger.info('SafetySupportScreen', 'Live location sharing started', {
          tourId,
          userId: maskIdentifier(userId),
          accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
        });

        if (Platform.OS === 'ios') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (error) {
        if (locationWatchRef.current) {
          locationWatchRef.current.remove();
          locationWatchRef.current = null;
        }
        if (!mountedRef.current) return;
        logger.error('SafetySupportScreen', 'Live location sharing start failed', {
          tourId,
          userId: maskIdentifier(userId),
          error: error?.message || String(error),
        });
        Alert.alert('Error', 'Could not start location sharing. Please try again.');
      }
    } else {
      try {
        // Stop watching
        if (locationWatchRef.current) {
          locationWatchRef.current.remove();
          locationWatchRef.current = null;
        }

        const shareStopped = await updateLiveLocationSharing(
          targetScope.tourId,
          targetScope.userId,
          false
        );
        if (!mountedRef.current) return;

        if (shareStopped) {
          setLiveLocationSharing(false);
          liveLocationSharingRef.current = false;
          activeLiveLocationScopeRef.current = null;
          setLiveLocationLastUpdate(null);
          logger.info('SafetySupportScreen', 'Live location sharing stopped', {
            tourId: targetScope.tourId,
            userId: maskIdentifier(targetScope.userId),
          });
        } else {
          logger.warn('SafetySupportScreen', 'Live location stop was not accepted by server', {
            tourId: targetScope.tourId,
            userId: maskIdentifier(targetScope.userId),
          });
          Alert.alert(
            'Could not confirm sharing stopped',
            'Automatic disconnect cleanup is still armed. Please try the switch again when connected.',
          );
        }
      } catch (error) {
        logger.warn('SafetySupportScreen', 'Live location sharing stop write failed', {
          tourId: targetScope.tourId,
          userId: maskIdentifier(targetScope.userId),
          error: error?.message || String(error),
        });
        if (mountedRef.current) {
          Alert.alert(
            'Could not confirm sharing stopped',
            'Automatic disconnect cleanup is still armed. Please try the switch again when connected.',
          );
        }
      }
    }

    if (mountedRef.current) {
      setLiveLocationUpdating(false);
    }
  };

  useEffect(() => {
    const activeScope = activeLiveLocationScopeRef.current;
    if (
      !activeScope
      || (activeScope.tourId === tourId && activeScope.userId === userId)
    ) return undefined;

    if (locationWatchRef.current) {
      locationWatchRef.current.remove();
      locationWatchRef.current = null;
    }
    updateLiveLocationSharing(activeScope.tourId, activeScope.userId, false).then((stopped) => {
      if (!mountedRef.current || !stopped) return;
      activeLiveLocationScopeRef.current = null;
      liveLocationSharingRef.current = false;
      setLiveLocationSharing(false);
      setLiveLocationLastUpdate(null);
    }).catch(() => {});
    return undefined;
  }, [tourId, userId]);

  // Cleanup location watch on unmount
  useEffect(() => {
    return () => {
      if (locationWatchRef.current) {
        logger.debug('SafetySupportScreen', 'Live location watcher cleaned up', {
          tourId,
          userId: maskIdentifier(userId),
        });
        locationWatchRef.current.remove();
      }
    };
  }, [tourId, userId]);

  // ==================== REPORT HANDLERS ====================

  return { startSOS, confirmAccessibleSOS, cancelSOS, executeSOS, toggleLiveLocation };
}
