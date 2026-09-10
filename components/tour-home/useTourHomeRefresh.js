import { useCallback, useEffect, useRef, useState } from 'react';
import * as bookingService from '../../services/bookingServiceRealtime';
import * as chatService from '../../services/chatService';
import offlineSyncService from '../../services/offlineSyncService';
import logger, { maskIdentifier } from '../../services/loggerService';
import { isTourHomeRealtimeAvailable, readTourHomeRealtimeSnapshot } from '../../services/tourHomeRealtimeService';
import { triggerHaptic } from './tourHomePresentation';

const EMPTY_OUTCOMES = { incoming: '', outgoing: '', optional: '' };
const REQUESTED_PARTS = ['booking', 'tour', 'itinerary'];

const describeIncomingResult = (result) => {
  const parts = result?.parts || {};
  const allChecked = REQUESTED_PARTS.every((part) => parts[part]?.status === 'checked');
  const hasError = REQUESTED_PARTS.some((part) => parts[part]?.status === 'error');
  const hasSaved = REQUESTED_PARTS.some((part) => parts[part]?.status === 'saved');
  const hasEmpty = REQUESTED_PARTS.some((part) => parts[part]?.status === 'empty');
  const saveFailed = REQUESTED_PARTS.some((part) => parts[part]?.persisted === false);
  if (allChecked) return `Trip details checked.${saveFailed ? ' Some details could not be saved offline.' : ''}`;
  if (hasError) return 'Trip details could not be refreshed. Your previous details remain shown.';
  if (hasSaved) return 'Saved trip details remain shown.';
  if (hasEmpty) return 'Trip details updated. No itinerary is published.';
  return 'Trip refresh did not complete. Your previous details remain shown.';
};

export default function useTourHomeRefresh({
  activeTourId,
  bookingRef,
  isConnected,
  passengerTrip,
  setDriverLocationRecord,
  setManifestStatus,
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [outcomes, setOutcomes] = useState(EMPTY_OUTCOMES);
  const mountedRef = useRef(true);
  const scopeRef = useRef(null);
  scopeRef.current = `${activeTourId}|${bookingRef}`;
  const usesPassengerTrip = Boolean(passengerTrip);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const onRefresh = useCallback(async () => {
    const capturedScope = scopeRef.current;
    const isCurrent = () => mountedRef.current && scopeRef.current === capturedScope;
    setRefreshing(true);
    setOutcomes(EMPTY_OUTCOMES);
    triggerHaptic('light');
    logger.info('TourHome', 'Manual refresh started', {
      sanitizedTourId: activeTourId,
      bookingRef: maskIdentifier(bookingRef),
      isConnected,
    });

    const incoming = usesPassengerTrip
      ? Promise.resolve().then(() => passengerTrip.refresh('manual', REQUESTED_PARTS))
      : Promise.resolve(null);
    const outgoing = Promise.resolve().then(() => offlineSyncService.replayQueue({
      services: { bookingService, chatService },
    }));
    const optional = activeTourId && bookingRef && isTourHomeRealtimeAvailable()
      ? Promise.resolve().then(() => readTourHomeRealtimeSnapshot({ bookingRef, tourId: activeTourId }))
      : Promise.resolve(null);

    const applyOptional = ({ driverSnapshot, manifestSnapshot } = {}) => {
      if (!isCurrent() || !driverSnapshot || !manifestSnapshot) return;
      setManifestStatus(manifestSnapshot.val()?.status || null);
      setDriverLocationRecord(driverSnapshot.val() || null);
    };
    const observeOutgoing = () => outgoing.then((result) => {
      logger.info('TourHome', 'Manual refresh replay completed', {
        sanitizedTourId: activeTourId,
        success: result?.success !== false,
        processed: result?.data?.processed ?? null,
        failed: result?.data?.failed ?? null,
      });
      if (isCurrent() && result?.success === false) {
        setOutcomes((current) => ({ ...current, outgoing: 'Some saved outgoing actions still need to send.' }));
      }
    }).catch(() => {
      if (isCurrent()) {
        setOutcomes((current) => ({ ...current, outgoing: 'Some saved outgoing actions still need to send.' }));
      }
    });
    const observeOptional = () => optional.then(applyOptional).catch(() => {
      if (isCurrent()) {
        setOutcomes((current) => ({ ...current, optional: 'Boarding status or bus location could not be checked.' }));
      }
    });

    try {
      if (usesPassengerTrip) {
        observeOutgoing();
        observeOptional();
        const result = await incoming;
        if (isCurrent()) {
          setOutcomes((current) => ({ ...current, incoming: describeIncomingResult(result) }));
        }
      } else {
        const [outgoingResult, optionalResult] = await Promise.allSettled([outgoing, optional]);
        if (optionalResult.status === 'fulfilled') applyOptional(optionalResult.value);
        if (isCurrent()) {
          setOutcomes({
            incoming: 'Tour details checked.',
            outgoing: outgoingResult.status === 'rejected' || outgoingResult.value?.success === false
              ? 'Some saved outgoing actions still need to send.' : '',
            optional: optionalResult.status === 'rejected'
              ? 'Boarding status or bus location could not be checked.' : '',
          });
        }
      }
    } catch (error) {
      logger.error('TourHome', 'Manual refresh failed', {
        sanitizedTourId: activeTourId,
        bookingRef: maskIdentifier(bookingRef),
        error: error?.message || String(error),
      });
      if (isCurrent()) {
        setOutcomes((current) => ({
          ...current,
          incoming: 'Trip details could not be refreshed. Your previous details remain shown.',
        }));
      }
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }, [activeTourId, bookingRef, isConnected, passengerTrip, setDriverLocationRecord, setManifestStatus, usesPassengerTrip]);

  return {
    onRefresh,
    refreshing,
    refreshNotice: Object.values(outcomes).filter(Boolean).join(' '),
  };
}
