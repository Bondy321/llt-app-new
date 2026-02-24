/**
 * functions/index.js
 * Backend logic for Loch Lomond Travel App
 * Updated for Cloud Functions Gen 2 (v2) - Region Fix
 * Enhanced with comprehensive error handling, validation, and performance improvements
 */

const { onValueCreated, onValueUpdated } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { Expo } = require("expo-server-sdk");

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Expo SDK
const expo = new Expo();

// ==================== UTILITY FUNCTIONS ====================

/**
 * Structured logger for better debugging and monitoring
 */
const log = {
  info: (message, data = {}) => console.log(JSON.stringify({ level: 'info', message, ...data, timestamp: new Date().toISOString() })),
  error: (message, error = {}, data = {}) => console.error(JSON.stringify({ level: 'error', message, error: error.message || error, stack: error.stack, ...data, timestamp: new Date().toISOString() })),
  warn: (message, data = {}) => console.warn(JSON.stringify({ level: 'warn', message, ...data, timestamp: new Date().toISOString() })),
};

/**
 * Validates message data
 */
const validateMessageData = (messageData) => {
  const errors = [];

  if (!messageData) {
    errors.push('Message data is null or undefined');
    return { valid: false, errors };
  }

  if (!messageData.senderId || typeof messageData.senderId !== 'string') {
    errors.push('Invalid or missing senderId');
  }

  if (!messageData.senderName || typeof messageData.senderName !== 'string') {
    errors.push('Invalid or missing senderName');
  }

  if (!messageData.text || typeof messageData.text !== 'string') {
    errors.push('Invalid or missing message text');
  } else if (messageData.text.length > 10000) {
    errors.push('Message text exceeds maximum length (10000 characters)');
  }

  return { valid: errors.length === 0, errors };
};

/**
 * Validates and sanitizes push token
 */
const isValidPushToken = (token) => {
  return token && typeof token === 'string' && Expo.isExpoPushToken(token);
};

/**
 * Safely removes invalid push tokens from user profiles
 */
const removeInvalidToken = async (userId, token) => {
  try {
    await admin.database().ref(`users/${userId}/pushToken`).remove();
    log.info('Removed invalid token', { userId });
  } catch (error) {
    log.error('Failed to remove invalid token', error, { userId });
  }
};

/**
 * Verifies user is a participant of the tour
 */
const verifyParticipant = async (tourId, userId) => {
  try {
    const participantSnapshot = await admin.database()
      .ref(`tours/${tourId}/participants/${userId}`)
      .once('value');
    return participantSnapshot.exists();
  } catch (error) {
    log.error('Error verifying participant', error, { tourId, userId });
    return false;
  }
};

/**
 * Checks if the sender claims to be an admin/HQ broadcast.
 * Returns true only if the senderId uses an admin prefix.
 * IMPORTANT: Must be paired with verifyAdminBroadcast() to prevent spoofing.
 */
const isAdminBroadcast = (senderId) => {
  return senderId && (
    senderId === 'admin_hq_broadcast' ||
    senderId.startsWith('admin_') ||
    senderId.startsWith('hq_')
  );
};

/**
 * Verifies that an admin broadcast is legitimate by checking the senderUid.
 * Rejects messages that claim admin status without a verified non-anonymous auth UID.
 */
const verifyAdminBroadcast = async (messageData) => {
  const { senderUid } = messageData;

  // Admin broadcasts must include a senderUid for verification
  if (!senderUid || typeof senderUid !== 'string') {
    return false;
  }

  try {
    // Verify the UID belongs to a real, non-anonymous user (admins use email/password auth)
    const userRecord = await admin.auth().getUser(senderUid);
    if (!userRecord || userRecord.disabled) {
      return false;
    }

    // Admin users authenticate with email/password, not anonymously
    const isAnonymous = userRecord.providerData.length === 0;
    if (isAnonymous) {
      return false;
    }

    return true;
  } catch (error) {
    log.error('Admin broadcast verification failed', error, { senderUid });
    return false;
  }
};

/**
 * Validates a Firebase path segment to prevent path traversal attacks.
 * Firebase keys cannot contain '.', '$', '#', '[', ']', or '/'.
 */
const isValidFirebaseKey = (key) => {
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    return false;
  }
  // Firebase keys cannot contain these characters
  return !/[./$#\[\]]/.test(key);
};

/**
 * Rate limiting check (simple implementation)
 */
const rateLimitCache = new Map();
const checkRateLimit = (key, maxRequests = 10, windowMs = 60000) => {
  const now = Date.now();
  const record = rateLimitCache.get(key) || { count: 0, resetTime: now + windowMs };

  // Reset if window expired
  if (now > record.resetTime) {
    rateLimitCache.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  // Check limit
  if (record.count >= maxRequests) {
    return false;
  }

  // Increment
  record.count++;
  rateLimitCache.set(key, record);
  return true;
};

/**
 * Cleanup old rate limit entries (called periodically)
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitCache.entries()) {
    if (now > record.resetTime) {
      rateLimitCache.delete(key);
    }
  }
}, 300000); // Clean up every 5 minutes



const parseTimestampToMillis = (timestamp) => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeBookingRef = (bookingRef) => {
  if (typeof bookingRef !== 'string') return '';
  return bookingRef.trim().toUpperCase();
};

const normalizeEmail = (email) => {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
};

const getRequestClientKey = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0].trim()
      : req.ip || req.connection?.remoteAddress || 'unknown';

  const explicitClientId = req.headers['x-client-id'];
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : 'unknown';
  const normalizedClientId = typeof explicitClientId === 'string' && explicitClientId.trim()
    ? explicitClientId.trim()
    : userAgent;

  return `${clientIp}:${normalizedClientId}`;
};

exports.verifyPassengerLogin = onRequest(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ valid: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`verify_passenger_login_${clientKey}`, 12, 60000)) {
      log.warn('Passenger login rate limit exceeded', { clientKey });
      return res.status(429).json({ valid: false, reason: 'TRY_AGAIN_LATER' });
    }

    const bookingRef = normalizeBookingRef(req.body?.bookingRef);
    const email = normalizeEmail(req.body?.email);

    if (!bookingRef || !email) {
      return res.status(400).json({ valid: false, reason: 'INVALID_INPUT' });
    }

    try {
      const requireAppCheck = process.env.REQUIRE_APP_CHECK_FOR_LOGIN !== 'false';
      const appCheckToken = req.headers['x-firebase-appcheck'];

      if (requireAppCheck) {
        if (typeof appCheckToken !== 'string' || !appCheckToken.trim()) {
          log.warn('Passenger login rejected: missing App Check token', { clientKey, bookingRef });
          return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
        }

        try {
          await admin.appCheck().verifyToken(appCheckToken.trim());
        } catch (appCheckError) {
          log.warn('Passenger login rejected: invalid App Check token', {
            clientKey,
            bookingRef,
            error: appCheckError.message,
          });
          return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
        }
      }

      const identitySnapshot = await admin.database().ref(`booking_identities/${bookingRef}`).once('value');

      if (!identitySnapshot.exists()) {
        log.warn('Passenger login verification failed', { bookingRef, clientKey, cause: 'BOOKING_NOT_FOUND' });
        return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
      }

      const identity = identitySnapshot.val() || {};
      const storedEmail = normalizeEmail(identity.email);

      if (!storedEmail || storedEmail !== email) {
        log.warn('Passenger login verification failed', { bookingRef, clientKey, cause: 'EMAIL_MISMATCH' });
        return res.status(401).json({ valid: false, reason: 'INVALID_CREDENTIALS' });
      }

      const resolvedBookingRef = normalizeBookingRef(identity.bookingRef || bookingRef);
      const resolvedTourId = typeof identity.tourId === 'string' ? identity.tourId.trim() : '';
      const resolvedTourCode = typeof identity.tourCode === 'string' ? identity.tourCode.trim() : '';

      if (!resolvedBookingRef || (!resolvedTourId && !resolvedTourCode)) {
        log.warn('Booking identity missing essential identifiers', { bookingRef });
        return res.status(200).json({ valid: false, reason: 'IDENTITY_INCOMPLETE' });
      }

      return res.status(200).json({
        valid: true,
        reason: 'OK',
        bookingRef: resolvedBookingRef,
        tourId: resolvedTourId || null,
        tourCode: resolvedTourCode || null,
      });
    } catch (error) {
      log.error('Passenger login verification failed', error, { bookingRef });
      return res.status(500).json({ valid: false, reason: 'INTERNAL_ERROR' });
    }
  }
);

/**
 * One-time migration helper:
 * Normalizes legacy broadcast timestamps (ISO strings) into numeric epoch milliseconds.
 * Usage: deploy, invoke once, then delete/disable if no longer needed.
 */
exports.normalizeRecentBroadcastTimestamps = onRequest(
  {
    region: "europe-west1",
    maxInstances: 1,
  },
  async (req, res) => {
    const days = Number(req.query.days || req.body?.days || 14);
    const dryRun = String(req.query.dryRun || req.body?.dryRun || 'true') === 'true';
    const cutoffMs = Date.now() - Math.max(days, 1) * 24 * 60 * 60 * 1000;

    try {
      const snapshot = await admin.database().ref('chats').once('value');
      const updates = {};
      let scanned = 0;
      let normalized = 0;

      snapshot.forEach((tourSnap) => {
        const tourId = tourSnap.key;
        const messagesSnap = tourSnap.child('messages');
        if (!messagesSnap.exists()) return;

        messagesSnap.forEach((messageSnap) => {
          scanned += 1;
          const value = messageSnap.val() || {};

          if (value?.messageType !== 'ADMIN_BROADCAST' && value?.source !== 'web_admin') {
            return;
          }

          const parsed = parseTimestampToMillis(value.timestamp);
          if (!parsed || parsed < cutoffMs) return;

          if (typeof value.timestamp !== 'number') {
            normalized += 1;
            updates[`chats/${tourId}/messages/${messageSnap.key}/timestamp`] = parsed;
          }
        });
      });

      if (!dryRun && Object.keys(updates).length > 0) {
        await admin.database().ref().update(updates);
      }

      return res.status(200).json({
        success: true,
        dryRun,
        days,
        scanned,
        normalized,
      });
    } catch (error) {
      log.error('Failed to normalize broadcast timestamps', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * Trigger: When a new message is added to /chats/{tourId}/messages/{messageId}
 * Enhanced with validation, security checks, and better error handling
 */
exports.sendChatNotification = onValueCreated(
  {
    ref: "/chats/{tourId}/messages/{messageId}",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    const startTime = Date.now();
    const tourId = event.params.tourId;
    const messageId = event.params.messageId;

    try {
      // 0. Validate path parameters
      if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(messageId)) {
        log.error("Invalid path parameters", null, { tourId, messageId });
        return null;
      }

      // 1. Validate event data
      const snapshot = event.data;
      if (!snapshot) {
        log.warn("No data associated with event", { tourId, messageId });
        return null;
      }

      const messageData = snapshot.val();

      // 2. Validate message data
      const validation = validateMessageData(messageData);
      if (!validation.valid) {
        log.error("Invalid message data", { errors: validation.errors }, { tourId, messageId });
        return null;
      }

      const { senderId, text: messageText, senderName } = messageData;

      // 3. Rate limiting check (prevent spam)
      const rateLimitKey = `chat_notify_${tourId}_${senderId}`;
      if (!checkRateLimit(rateLimitKey, 20, 60000)) {
        log.warn("Rate limit exceeded", { tourId, senderId });
        return null;
      }

      // 4. Security: Verify sender is actually a participant (prevent spoofing)
      // Admin broadcasts require verified admin UID; regular messages require participant membership
      let isAdmin = isAdminBroadcast(senderId);
      if (isAdmin) {
        // Verify the admin broadcast is legitimate (not spoofed by a regular user)
        const isVerifiedAdmin = await verifyAdminBroadcast(messageData);
        if (!isVerifiedAdmin) {
          log.error("Spoofed admin broadcast rejected - invalid or missing senderUid", null, { tourId, senderId });
          return null;
        }
      } else {
        const isParticipant = await verifyParticipant(tourId, senderId);
        if (!isParticipant) {
          log.error("Sender is not a participant of the tour", null, { tourId, senderId });
          return null;
        }
      }

      log.info("Processing chat notification", { tourId, senderId, senderName, isAdmin });

      // 5. Get tour details and participants in parallel
      const [tourSnapshot, participantsSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}`).once("value"),
        admin.database().ref(`tours/${tourId}/participants`).once("value")
      ]);

      const tourData = tourSnapshot.val();
      if (!tourData) {
        log.error("Tour not found", null, { tourId });
        return null;
      }

      const tourName = tourData.name || "Tour Chat";

      if (!participantsSnapshot.exists()) {
        log.info("No participants found", { tourId });
        return null;
      }

      const participants = participantsSnapshot.val();
      const participantIds = Object.keys(participants);
      const pushMessages = [];
      const invalidTokens = [];

      // 6. Fetch user data and build notification messages
      const userFetchPromises = participantIds.map(async (userId) => {
        // Don't notify sender
        if (userId === senderId) return;

        try {
          const userSnapshot = await admin.database().ref(`users/${userId}`).once("value");
          const userData = userSnapshot.val();

          // Skip if no user data or token
          if (!userData || !userData.pushToken) {
            log.info("No token for user", { userId, tourId });
            return;
          }

          // Check notification preferences
          // Admin broadcasts use driver_updates preference (operational announcements)
          // Regular chat messages use group_chat preference
          const prefKey = isAdmin ? 'driver_updates' : 'group_chat';
          const wantsUpdates = userData.preferences?.ops?.[prefKey] ?? true;
          if (!wantsUpdates) {
            log.info(`User has muted ${prefKey} notifications`, { userId, tourId, prefKey });
            return;
          }

          // Validate token
          if (!isValidPushToken(userData.pushToken)) {
            log.warn("Invalid push token", { userId });
            invalidTokens.push({ userId, token: userData.pushToken });
            return;
          }

          // Truncate message for notification if too long
          const truncatedMessage = messageText.length > 200
            ? messageText.substring(0, 197) + '...'
            : messageText;

          // Admin broadcasts get distinctive formatting
          const notificationTitle = isAdmin
            ? `📢 ${tourName} Announcement`
            : `New message in ${tourName}`;
          const notificationBody = isAdmin
            ? truncatedMessage.replace(/^ANNOUNCEMENT:\s*/i, '')  // Remove prefix if present
            : `${senderName}: ${truncatedMessage}`;

          pushMessages.push({
            to: userData.pushToken,
            sound: "default",
            title: notificationTitle,
            body: notificationBody,
            data: {
              tourId: tourId,
              screen: "Chat",
              messageId: messageId,
              isAdminBroadcast: isAdmin,
            },
            priority: isAdmin ? "high" : "default",  // Admin broadcasts are high priority
            channelId: "default",
          });
        } catch (userError) {
          log.error("Error processing user", userError, { userId, tourId });
        }
      });

      await Promise.all(userFetchPromises);

      // 7. Clean up invalid tokens (async, don't wait)
      if (invalidTokens.length > 0) {
        Promise.all(invalidTokens.map(({ userId, token }) => removeInvalidToken(userId, token)))
          .catch(err => log.error("Error cleaning invalid tokens", err));
      }

      // 8. Send notifications via Expo
      if (pushMessages.length === 0) {
        log.info("No valid recipients found", { tourId });
        return null;
      }

      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);

          // Check for errors in tickets
          ticketChunk.forEach((ticket, index) => {
            if (ticket.status === 'error') {
              errorCount++;
              log.error("Notification ticket error", {
                error: ticket.message,
                details: ticket.details
              }, { tourId });
            } else {
              successCount++;
            }
          });
        } catch (chunkError) {
          errorCount += chunk.length;
          log.error("Error sending notification chunk", chunkError, { tourId, chunkSize: chunk.length });
        }
      }

      const duration = Date.now() - startTime;
      log.info("Chat notification completed", {
        tourId,
        recipients: pushMessages.length,
        successCount,
        errorCount,
        isAdminBroadcast: isAdmin,
        duration: `${duration}ms`
      });

      return null;

    } catch (error) {
      const duration = Date.now() - startTime;
      log.error("Fatal error in sendChatNotification", error, { tourId, messageId, duration: `${duration}ms` });
      return null;
    }
  }
);
/**
 * Trigger: When the itinerary is updated at /tours/{tourId}/itinerary
 * Enhanced with validation, better error handling, and performance tracking
 */
exports.sendItineraryNotification = onValueUpdated(
  {
    ref: "/tours/{tourId}/itinerary",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    const startTime = Date.now();
    const tourId = event.params.tourId;

    try {
      // 0. Validate path parameters
      if (!isValidFirebaseKey(tourId)) {
        log.error("Invalid tourId path parameter", null, { tourId });
        return null;
      }

      log.info("Processing itinerary update notification", { tourId });

      // 1. Rate limiting check (prevent notification spam on rapid updates)
      const rateLimitKey = `itinerary_notify_${tourId}`;
      if (!checkRateLimit(rateLimitKey, 5, 300000)) { // Max 5 updates per 5 minutes
        log.warn("Itinerary update rate limit exceeded", { tourId });
        return null;
      }

      // 2. Get tour details and participants in parallel
      const [nameSnapshot, participantsSnapshot, tourSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/name`).once("value"),
        admin.database().ref(`tours/${tourId}/participants`).once("value"),
        admin.database().ref(`tours/${tourId}`).once("value")
      ]);

      const tourData = tourSnapshot.val();
      if (!tourData) {
        log.error("Tour not found", null, { tourId });
        return null;
      }

      // Check if tour is active
      if (tourData.isActive === false) {
        log.info("Tour is inactive, skipping notification", { tourId });
        return null;
      }

      const tourName = nameSnapshot.val() || "Your Tour";

      if (!participantsSnapshot.exists()) {
        log.info("No participants for itinerary update", { tourId });
        return null;
      }

      const participants = participantsSnapshot.val();
      const participantIds = Object.keys(participants);
      const pushMessages = [];
      const invalidTokens = [];

      // 3. Fetch user data and build notification messages
      const userFetchPromises = participantIds.map(async (userId) => {
        try {
          const userSnapshot = await admin.database().ref(`users/${userId}`).once("value");
          const userData = userSnapshot.val();

          // Skip if no user data or token
          if (!userData || !userData.pushToken) {
            log.info("No token for user", { userId, tourId });
            return;
          }

          // Check notification preferences
          const wantsUpdates = userData.preferences?.ops?.itinerary_changes ?? true;
          if (!wantsUpdates) {
            log.info("User opted out of itinerary updates", { userId, tourId });
            return;
          }

          // Validate token
          if (!isValidPushToken(userData.pushToken)) {
            log.warn("Invalid push token", { userId });
            invalidTokens.push({ userId, token: userData.pushToken });
            return;
          }

          pushMessages.push({
            to: userData.pushToken,
            sound: "default",
            title: "📅 Itinerary Update",
            body: `The schedule for ${tourName} has been updated. Tap to see the changes.`,
            data: {
              tourId: tourId,
              screen: "Itinerary",
              timestamp: Date.now(),
            },
            priority: "default",
            channelId: "default",
          });
        } catch (userError) {
          log.error("Error processing user", userError, { userId, tourId });
        }
      });

      await Promise.all(userFetchPromises);

      // 4. Clean up invalid tokens (async, don't wait)
      if (invalidTokens.length > 0) {
        Promise.all(invalidTokens.map(({ userId, token }) => removeInvalidToken(userId, token)))
          .catch(err => log.error("Error cleaning invalid tokens", err));
      }

      // 5. Send notifications via Expo
      if (pushMessages.length === 0) {
        log.info("No valid recipients for itinerary update", { tourId });
        return null;
      }

      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);

          // Check for errors in tickets
          ticketChunk.forEach((ticket) => {
            if (ticket.status === 'error') {
              errorCount++;
              log.error("Notification ticket error", {
                error: ticket.message,
                details: ticket.details
              }, { tourId });
            } else {
              successCount++;
            }
          });
        } catch (chunkError) {
          errorCount += chunk.length;
          log.error("Error sending notification chunk", chunkError, { tourId, chunkSize: chunk.length });
        }
      }

      const duration = Date.now() - startTime;
      log.info("Itinerary notification completed", {
        tourId,
        recipients: pushMessages.length,
        successCount,
        errorCount,
        duration: `${duration}ms`
      });

      return null;

    } catch (error) {
      const duration = Date.now() - startTime;
      log.error("Fatal error in sendItineraryNotification", error, { tourId, duration: `${duration}ms` });
      return null;
    }
  }
);
