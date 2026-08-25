const {
  getReactionEmojiPath,
  getReactionEmojiReadRef,
  getReactionLeafPath,
  getReactionLeafRef,
  getRealtimeActorContext,
  isValidFirebaseKey,
  logChatEvent,
  logReactionEvent,
  mapReactionFailureReason,
  maskUserId,
  normalizeReactionUsers,
  resolveRealtimeDb,
  summarizeErrorForDbLog,
  summarizeReactionUsersForDebug,
  validateMessageId,
  validateTourId,
} = require('./chatServiceContext');

const addReaction = async (tourId, messageId, emoji, userId, dbInstance) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedMessageId = validateMessageId(messageId);
    const {
      rawUserId: validatedUserId,
      actorKey,
      actorKeyWasEncoded,
      actorKeyIsRealtimeSafe,
    } = getRealtimeActorContext(userId);

    if (!emoji || typeof emoji !== 'string' || emoji.trim().length === 0) {
      return { success: false, error: 'Invalid emoji' };
    }

    const sanitizedEmoji = emoji.trim();
    if (!isValidFirebaseKey(sanitizedEmoji)) {
      return { success: false, error: 'Invalid emoji character for database key' };
    }

    const db = dbInstance || resolveRealtimeDb();
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    logReactionEvent('info', 'reaction_add_write_start', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId: maskUserId(validatedUserId),
      actorKey,
      actorKeyWasEncoded,
      reactionLeafPath: getReactionLeafPath(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey),
      actorKeyIsRealtimeSafe,
    });

    const reactionLeafRef = getReactionLeafRef(
      db,
      validatedTourId,
      validatedMessageId,
      sanitizedEmoji,
      actorKey
    );

    await reactionLeafRef.set(true);
    logReactionEvent('info', 'reaction_add_write_complete', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId: maskUserId(validatedUserId),
    });
    return { success: true };
  } catch (error) {
    logChatEvent('error', 'reaction_add_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      messageId: typeof messageId === 'string' ? messageId.trim() : null,
      emoji,
      maskedUserId: maskUserId(userId),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

// Remove a reaction from a message
const removeReaction = async (tourId, messageId, emoji, userId, dbInstance) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedMessageId = validateMessageId(messageId);
    const {
      rawUserId: validatedUserId,
      actorKey,
      actorKeyWasEncoded,
      actorKeyIsRealtimeSafe,
    } = getRealtimeActorContext(userId);

    if (!emoji || typeof emoji !== 'string' || emoji.trim().length === 0) {
      return { success: false, error: 'Invalid emoji' };
    }

    const sanitizedEmoji = emoji.trim();
    if (!isValidFirebaseKey(sanitizedEmoji)) {
      return { success: false, error: 'Invalid emoji character for database key' };
    }

    const db = dbInstance || resolveRealtimeDb();
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    logReactionEvent('info', 'reaction_remove_write_start', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId: maskUserId(validatedUserId),
      actorKey,
      actorKeyWasEncoded,
      reactionLeafPath: getReactionLeafPath(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey),
      actorKeyIsRealtimeSafe,
    });

    const reactionLeafRef = getReactionLeafRef(
      db,
      validatedTourId,
      validatedMessageId,
      sanitizedEmoji,
      actorKey
    );

    await reactionLeafRef.remove();
    logReactionEvent('info', 'reaction_remove_write_complete', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId: maskUserId(validatedUserId),
    });
    return { success: true };
  } catch (error) {
    logChatEvent('error', 'reaction_remove_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      messageId: typeof messageId === 'string' ? messageId.trim() : null,
      emoji,
      maskedUserId: maskUserId(userId),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

// Toggle a reaction (add if not present, remove if present)
// IMPORTANT: toggles never overwrite reactions/{emoji}; only leaf set/remove writes are allowed.
const toggleReaction = async (tourId, messageId, emoji, userId, dbInstance, options = {}) => {
  const normalizedEmoji = typeof emoji === 'string' ? emoji.trim() : '';
  const maskedUserId = maskUserId(userId);
  logReactionEvent('info', 'reaction_toggle_attempt', {
    tourId: typeof tourId === 'string' ? tourId.trim() : '',
    messageId: typeof messageId === 'string' ? messageId.trim() : '',
    emoji: normalizedEmoji,
    maskedUserId,
  });

  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    const validatedMessageId = validateMessageId(messageId);
    const {
      rawUserId: _validatedUserId,
      actorKey,
      actorKeyWasEncoded,
      actorKeyIsRealtimeSafe,
    } = getRealtimeActorContext(userId);

    if (!emoji || typeof emoji !== 'string' || emoji.trim().length === 0) {
      return { success: false, error: 'Invalid emoji' };
    }

    const sanitizedEmoji = emoji.trim();
    if (!isValidFirebaseKey(sanitizedEmoji)) {
      return { success: false, error: 'Invalid emoji character for database key' };
    }

    const db = dbInstance || resolveRealtimeDb();
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    logReactionEvent('info', 'reaction_toggle_validated_context', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId,
      actorKey,
      actorKeyWasEncoded,
      reactionLeafPath: getReactionLeafPath(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey),
      reactionEmojiPath: getReactionEmojiPath(validatedTourId, validatedMessageId, sanitizedEmoji),
      actorKeyIsRealtimeSafe,
      forceAction: options.forceAction || null,
    });

    // Read-only parent ref; all writes must remain user-leaf only: reactions/{emoji}/{userId}.
    const emojiReadRef = getReactionEmojiReadRef(db, validatedTourId, validatedMessageId, sanitizedEmoji);
    const reactionLeafSnapshot = await getReactionLeafRef(
      db,
      validatedTourId,
      validatedMessageId,
      sanitizedEmoji,
      actorKey
    ).once('value');
    const hasUserReaction = reactionLeafSnapshot.exists();
    logReactionEvent('info', 'reaction_toggle_leaf_snapshot', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId,
      actorKey,
      actorKeyWasEncoded,
      reactionLeafPath: getReactionLeafPath(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey),
      leafExists: hasUserReaction,
      leafValueType: reactionLeafSnapshot.val() === true ? 'true' : typeof reactionLeafSnapshot.val(),
    });
    const getNormalizedReactionPayload = async () => {
      const nextSnapshot = await emojiReadRef.once('value');
      const users = normalizeReactionUsers(nextSnapshot.val());
      const reactions = users.length > 0 ? { [sanitizedEmoji]: users } : {};
      logReactionEvent('info', 'reaction_toggle_emoji_snapshot', {
        tourId: validatedTourId,
        messageId: validatedMessageId,
        emoji: sanitizedEmoji,
        maskedUserId,
        actorKey,
        reactionEmojiPath: getReactionEmojiPath(validatedTourId, validatedMessageId, sanitizedEmoji),
        rawEmojiNodeType: nextSnapshot.val() === null ? 'null' : Array.isArray(nextSnapshot.val()) ? 'array' : typeof nextSnapshot.val(),
        rawEmojiNodeKeys: nextSnapshot.val() && typeof nextSnapshot.val() === 'object'
          ? Object.keys(nextSnapshot.val()).slice(0, 12)
          : [],
        ...summarizeReactionUsersForDebug(nextSnapshot.val(), actorKey),
      });
      return { users, reactions };
    };

    if (options.forceAction === 'add') {
      const addResult = await addReaction(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey, db);
      if (!addResult?.success) {
        throw new Error(addResult?.error || 'Failed to add reaction');
      }
      const payload = await getNormalizedReactionPayload();
      logReactionEvent('info', 'reaction_toggle_success', {
        tourId: validatedTourId,
        messageId: validatedMessageId,
        emoji: sanitizedEmoji,
        maskedUserId,
        action: 'added',
      });
      return { success: true, action: 'added', ...payload };
    }

    if (options.forceAction === 'remove') {
      const removeResult = await removeReaction(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey, db);
      if (!removeResult?.success) {
        throw new Error(removeResult?.error || 'Failed to remove reaction');
      }
      const payload = await getNormalizedReactionPayload();
      logReactionEvent('info', 'reaction_toggle_success', {
        tourId: validatedTourId,
        messageId: validatedMessageId,
        emoji: sanitizedEmoji,
        maskedUserId,
        action: 'removed',
      });
      return { success: true, action: 'removed', ...payload };
    }

    if (hasUserReaction) {
      const removeResult = await removeReaction(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey, db);
      if (!removeResult?.success) {
        throw new Error(removeResult?.error || 'Failed to remove reaction');
      }
      const payload = await getNormalizedReactionPayload();
      logReactionEvent('info', 'reaction_toggle_success', {
        tourId: validatedTourId,
        messageId: validatedMessageId,
        emoji: sanitizedEmoji,
        maskedUserId,
        action: 'removed',
      });
      return { success: true, action: 'removed', ...payload };
    }

    const addResult = await addReaction(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey, db);
    if (!addResult?.success) {
      throw new Error(addResult?.error || 'Failed to add reaction');
    }
    const payload = await getNormalizedReactionPayload();
    logReactionEvent('info', 'reaction_toggle_success', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId,
      action: 'added',
    });
    return { success: true, action: 'added', ...payload };
  } catch (error) {
    const reason = mapReactionFailureReason(error);
    logReactionEvent('warn', 'reaction_toggle_failure', {
      reason,
      tourId: typeof tourId === 'string' ? tourId.trim() : '',
      messageId: typeof messageId === 'string' ? messageId.trim() : '',
      emoji: normalizedEmoji,
      maskedUserId,
      errorCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      errorMessage: typeof error?.message === 'string' ? error.message : 'Unknown reaction toggle failure',
    });
    return { success: false, error: error.message };
  }
};

// ==================== TYPING INDICATORS ====================

module.exports = { addReaction, removeReaction, toggleReaction };

// Update typing status for a user
