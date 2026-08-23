import React, { memo } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { COLORS, SHADOWS } from '../theme';

const iconByType = {
  announcement: 'bullhorn-outline',
  itinerary: 'calendar-clock-outline',
};

const formatRelativeTime = (timestampMs, now = Date.now()) => {
  if (!Number.isFinite(timestampMs)) return '';
  const minutes = Math.max(0, Math.floor((now - timestampMs) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestampMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

const NotificationFeedCard = ({
  items = [],
  unreadCount = 0,
  loading = false,
  error = '',
  stale = false,
  busy = false,
  onOpen,
  onMarkAll,
  onRetry,
}) => (
  <View style={styles.card}>
    <View style={styles.headerRow}>
      <View style={styles.headingWrap}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Recent tour updates</Text>
          {unreadCount > 0 ? (
            <View style={styles.badge} accessibilityLabel={`${unreadCount} unread updates`}>
              <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.subtitle}>Announcements and itinerary changes stay here even if you miss the push.</Text>
      </View>
      {unreadCount > 0 ? (
        <TouchableOpacity
          onPress={onMarkAll}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Mark all tour updates as read"
          style={styles.markAllButton}
        >
          {busy ? <ActivityIndicator size="small" color={COLORS.primary} /> : <Text style={styles.markAllText}>Mark all read</Text>}
        </TouchableOpacity>
      ) : null}
    </View>

    {loading && items.length === 0 ? (
      <View style={styles.stateRow}>
        <ActivityIndicator size="small" color={COLORS.primary} />
        <Text style={styles.stateText}>Loading updates...</Text>
      </View>
    ) : null}

    {error ? (
      <View style={[styles.stateRow, styles.errorState]}>
        <MaterialCommunityIcons name="cloud-alert-outline" size={20} color={COLORS.error} />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading tour updates"
          style={styles.retryButton}
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    ) : stale && items.length > 0 ? (
      <View style={[styles.stateRow, styles.staleState]}>
        <MaterialCommunityIcons name="cloud-off-outline" size={18} color={COLORS.warning} />
        <Text style={styles.staleText}>Showing saved updates while the live feed reconnects.</Text>
      </View>
    ) : null}

    {!loading && !error && items.length === 0 ? (
      <View style={styles.emptyState}>
        <View style={styles.emptyIcon}>
          <MaterialCommunityIcons name="bell-check-outline" size={24} color={COLORS.primary} />
        </View>
        <View style={styles.emptyCopy}>
          <Text style={styles.emptyTitle}>You are all caught up</Text>
          <Text style={styles.stateText}>New operational updates will appear here.</Text>
        </View>
      </View>
    ) : null}

    {items.length > 0 ? (
      <View style={styles.list}>
        {items.slice(0, 8).map((item, index) => (
          <TouchableOpacity
            key={item.id}
            style={[
              styles.item,
              !item.isRead && styles.unreadItem,
              index === items.slice(0, 8).length - 1 && styles.lastItem,
            ]}
            onPress={() => onOpen?.(item)}
            accessibilityRole="button"
            accessibilityLabel={`${item.isRead ? '' : 'Unread '}${item.title}. ${item.body}`}
          >
            <View style={[styles.itemIcon, !item.isRead && styles.unreadIcon]}>
              <MaterialCommunityIcons
                name={iconByType[item.type] || 'bell-outline'}
                size={20}
                color={item.isRead ? COLORS.textSecondary : COLORS.primary}
              />
            </View>
            <View style={styles.itemCopy}>
              <View style={styles.itemTitleRow}>
                <Text style={[styles.itemTitle, !item.isRead && styles.unreadTitle]} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.itemTime}>{formatRelativeTime(item.createdAtMs)}</Text>
              </View>
              <Text style={styles.itemBody} numberOfLines={2}>{item.body}</Text>
            </View>
            {!item.isRead ? <View style={styles.unreadDot} /> : <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.textMuted} />}
          </TouchableOpacity>
        ))}
      </View>
    ) : null}
  </View>
);

export { formatRelativeTime };
export default memo(NotificationFeedCard);

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 18,
    overflow: 'hidden',
    ...SHADOWS.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', padding: 16, gap: 12 },
  headingWrap: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: COLORS.textPrimary, fontSize: 17, fontWeight: '800' },
  subtitle: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 4 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primary },
  badgeText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  markAllButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 6 },
  markAllText: { color: COLORS.primary, fontSize: 12, fontWeight: '800' },
  list: { borderTopWidth: 1, borderTopColor: COLORS.border },
  item: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border, backgroundColor: COLORS.white },
  unreadItem: { backgroundColor: COLORS.primaryMuted || '#EFF6FF' },
  lastItem: { borderBottomWidth: 0 },
  itemIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.background },
  unreadIcon: { backgroundColor: '#DBEAFE' },
  itemCopy: { flex: 1, minWidth: 0 },
  itemTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemTitle: { flex: 1, color: COLORS.textPrimary, fontSize: 14, fontWeight: '600' },
  unreadTitle: { fontWeight: '800' },
  itemTime: { color: COLORS.textMuted, fontSize: 11, fontWeight: '600' },
  itemBody: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 3 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary },
  stateRow: { minHeight: 82, borderTopWidth: 1, borderTopColor: COLORS.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 16 },
  stateText: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 18 },
  errorState: { backgroundColor: COLORS.errorLight || '#FEF2F2' },
  errorText: { flex: 1, color: COLORS.error, fontSize: 13, lineHeight: 18 },
  retryButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 8 },
  retryText: { color: COLORS.error, fontSize: 12, fontWeight: '800' },
  staleState: { backgroundColor: COLORS.warningLight || '#FFFBEB' },
  staleText: { flex: 1, color: COLORS.textSecondary, fontSize: 12, lineHeight: 17 },
  emptyState: { minHeight: 92, borderTopWidth: 1, borderTopColor: COLORS.border, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  emptyIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primaryMuted || '#EFF6FF' },
  emptyCopy: { flex: 1 },
  emptyTitle: { color: COLORS.textPrimary, fontSize: 14, fontWeight: '800', marginBottom: 2 },
});
