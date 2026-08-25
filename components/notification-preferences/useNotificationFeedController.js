import { useEffect, useState } from 'react';

import logger from '../../services/loggerService';
import {
  markAllNotificationsRead,
  markNotificationRead,
  subscribeToNotificationFeed,
} from '../../services/notificationInboxService';
import { parseTimestampMs } from '../../services/timeUtils';

const formatTimestamp = (isoDate) => {
  const parsedMs = parseTimestampMs(isoDate);
  if (!Number.isFinite(parsedMs)) return '';
  return new Date(parsedMs).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export default function useNotificationFeedController({
  cacheOwnerId,
  isOnboarding,
  mountedRef,
  onNavigate,
  tourId,
  userId,
}) {
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isOnboarding || !tourId || !userId) {
      setItems([]);
      setUnreadCount(0);
      setLoading(false);
      setError('');
      setStale(false);
      return undefined;
    }

    setLoading(true);
    setError('');
    try {
      return subscribeToNotificationFeed({
        tourId,
        userId,
        cacheOwnerId,
        readStateOwnerId: cacheOwnerId,
        onUpdate: ({ items: nextItems, unreadCount: nextUnreadCount, stale: nextStale = false }) => {
          if (!mountedRef.current) return;
          setItems(nextItems);
          setUnreadCount(nextUnreadCount);
          setLoading(false);
          setError('');
          setStale(nextStale);
        },
        onError: (feedError, recovery = {}) => {
          if (!mountedRef.current) return;
          logger.warn('NotificationPreferences', 'Tour update feed failed', {
            error: feedError?.message || String(feedError),
          });
          setLoading(false);
          setStale(recovery.stale === true && recovery.hasItems === true);
          setError(recovery.hasPersistedCache
            ? 'Live updates could not be refreshed. Saved updates are still shown below.'
            : recovery.hasItems
              ? 'Live updates could not be refreshed. Your current updates remain shown below.'
              : 'Tour updates could not be refreshed. Your alert preferences are still available below.');
        },
      });
    } catch (feedError) {
      logger.warn('NotificationPreferences', 'Tour update feed could not start', {
        error: feedError?.message || String(feedError),
      });
      setLoading(false);
      setError('Tour updates are temporarily unavailable.');
      return undefined;
    }
  }, [cacheOwnerId, isOnboarding, mountedRef, retryKey, tourId, userId]);

  const retry = () => {
    setLoading(true);
    setError('');
    setRetryKey((value) => value + 1);
  };

  const open = async (item) => {
    if (!item) return;
    if (!item.isRead) {
      setItems((current) => current.map((notice) => (
        notice.noticeId === item.noticeId
          ? { ...notice, isRead: true, readAtMs: Date.now() }
          : notice
      )));
      setUnreadCount((current) => Math.max(0, current - 1));
    }
    onNavigate?.(item.screen, {
      tourId: item.tourId,
      noticeId: item.noticeId,
      messageId: item.messageId,
      departureKey: item.departureKey,
      revision: item.revision,
      changedSections: item.changedSections,
      critical: item.critical === true,
      requiresAcknowledgement: item.requiresAcknowledgement === true,
      fromNotification: true,
    });
    if (!item.isRead) {
      try {
        await markNotificationRead({ tourId, userId, readStateOwnerId: cacheOwnerId, noticeId: item.noticeId });
      } catch (readError) {
        logger.warn('NotificationPreferences', 'Tour update read state could not be saved', {
          noticeType: item.type,
          error: readError?.message || String(readError),
        });
      }
    }
  };

  const markAllRead = async () => {
    if (busy || unreadCount === 0) return;
    setBusy(true);
    try {
      await markAllNotificationsRead({
        tourId,
        userId,
        readStateOwnerId: cacheOwnerId,
        noticeIds: items.filter((item) => !item.isRead).map((item) => item.noticeId),
      });
    } catch (markError) {
      logger.warn('NotificationPreferences', 'Mark-all-read failed', {
        error: markError?.message || String(markError),
      });
      setError('Updates could not be marked as read. Please retry.');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return { busy, error, formatTimestamp, items, loading, markAllRead, open, retry, stale, unreadCount };
}
