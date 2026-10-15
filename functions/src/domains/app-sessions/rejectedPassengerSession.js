'use strict';

// @ts-check

const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { cleanupAppSession } = loadLegacyLibrary('appSessionCleanup');
const { renewAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { isValidAppSessionId } = loadLegacyLibrary('appSession');

/** Revoke only the rejected issuance, including when its former lease was lost. */
const invalidateExactSession = async ({ db, session }) => {
  const result = await db.ref(`app_sessions/${session.authUid}`).transaction((current) => {
    // Null can be a cold local cache; compare with the server before succeeding.
    if (current === null) return null;
    if (current.sessionId !== session.sessionId) return undefined;
    return null;
  }, undefined, false);
  return Boolean(result?.committed && !result.snapshot.exists());
};

/**
 * The caller still owns its issuance lease. Normal cleanup preserves durable
 * history. If cleanup cannot finish, exact-session invalidation immediately
 * removes app authority without touching a replacement login or another phone.
 */
const retireRejectedPassengerSession = async ({
  db,
  session,
  appSessionLock,
  clock = Date.now,
  cleanupSession = cleanupAppSession,
  renewSessionLock = renewAppSessionLock,
}) => {
  if (!db || session?.principalType !== 'passenger' || !session.authUid
    || !isValidAppSessionId(session.sessionId)) throw new Error('Invalid rejected passenger session');
  const held = appSessionLock?.acquired === true && Boolean(appSessionLock.owner)
    && await renewSessionLock({ db, authUid: session.authUid, owner: appSessionLock.owner,
      nowMs: clock(), ttlMs: 3 * 60 * 1000 });
  if (!held) {
    return { retired: await invalidateExactSession({ db, session }), cleanupPending: true };
  }
  const current = (await db.ref(`app_sessions/${session.authUid}`).once('value')).val();
  if (!current) return { retired: true, cleanupPending: false };
  if (current.sessionId !== session.sessionId) return { retired: false, cleanupPending: false };
  try {
    await cleanupSession({ db, session: current, expectedSessionId: session.sessionId,
      eventType: 'rejected', reason: 'login_source_changed', actorType: 'system', nowMs: clock() });
    return { retired: true, cleanupPending: false };
  } catch {
    return { retired: await invalidateExactSession({ db, session }), cleanupPending: true };
  }
};

module.exports = { retireRejectedPassengerSession };
