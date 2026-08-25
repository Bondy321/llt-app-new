import { COLORS as THEME } from '../../theme';
import { getMinutesAgo, parseTimestampMs } from '../../services/timeUtils';

const COLORS = {
  primaryBlue: THEME.primary,
  secondaryText: THEME.textSecondary,
  success: THEME.success || '#10B981',
  warning: '#F59E0B',
};

export const summarizeCoords = (coords) => {
  if (!coords) return { present: false };
  const latitude = Number(coords.latitude ?? coords.lat);
  const longitude = Number(coords.longitude ?? coords.lng);
  return {
    present: Number.isFinite(latitude) && Number.isFinite(longitude),
    latitudeApprox: Number.isFinite(latitude) ? Number(latitude.toFixed(3)) : null,
    longitudeApprox: Number.isFinite(longitude) ? Number(longitude.toFixed(3)) : null,
    hasAccuracy: Number.isFinite(Number(coords.accuracy)),
    accuracy: Number.isFinite(Number(coords.accuracy)) ? Math.round(Number(coords.accuracy)) : null,
  };
};

export const normalizeMapCoords = (coords) => {
  if (!coords) return null;
  const latitude = Number(coords.latitude ?? coords.lat);
  const longitude = Number(coords.longitude ?? coords.lng);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    ...coords,
    latitude,
    longitude,
  };
};

export const calculateDistanceKm = (pointA, pointB) => {
    const toRad = (value) => (value * Math.PI) / 180;
    const earthRadiusKm = 6371;

    const dLat = toRad(pointB.latitude - pointA.latitude);
    const dLon = toRad(pointB.longitude - pointA.longitude);

    const lat1 = toRad(pointA.latitude);
    const lat2 = toRad(pointB.latitude);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  };

export const formatRelativeTime = (isoString) => {
    const diffMinutes = getMinutesAgo(isoString);
    if (!Number.isFinite(diffMinutes)) return '';
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes === 1) return '1 min ago';
    if (diffMinutes < 60) return `${diffMinutes} mins ago`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
  };

export const formatTime = (isoString) => {
    const parsedMs = parseTimestampMs(isoString);
    if (!Number.isFinite(parsedMs)) return '';
    const date = new Date(parsedMs);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

export const estimateEtaMinutes = (distanceKm) => {
    if (!distanceKm) return null;
    const averageSpeedKmh = 35; // Highland roads are slower; keep ETA conservative
    const minutes = Math.round((distanceKm / averageSpeedKmh) * 60);
    return Math.max(minutes, 2); // Never show zero-minute arrivals
  };

export const getFreshnessConfig = (freshness) => {
    switch (freshness) {
      case 'live':
        return { color: COLORS.success, label: 'LIVE NOW', icon: 'broadcast' };
      case 'recent':
        return { color: COLORS.primaryBlue, label: 'LIVE (RECENT)', icon: 'clock-check-outline' };
      case 'stale':
        return { color: COLORS.warning, label: 'STALE', icon: 'clock-alert-outline' };
      case 'pickup':
        return { color: COLORS.primaryBlue, label: 'PICKUP POINT', icon: 'map-marker-check-outline' };
      case 'low_accuracy':
        return { color: COLORS.warning, label: 'LOW ACCURACY', icon: 'crosshairs-question' };
      default:
        return { color: COLORS.secondaryText, label: 'UNKNOWN', icon: 'help-circle-outline' };
    }
  };
