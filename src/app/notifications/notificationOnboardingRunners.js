export const runLoadNotificationOnboardingState = async ({ SESSION_KEYS, SessionStorage, logger }) => {
    try {
      const raw = await SessionStorage.multiGet([SESSION_KEYS.NOTIFICATION_ONBOARDING]);
      const serialized = raw?.[0]?.[1];
      if (!serialized) return null;
      const parsed = JSON.parse(serialized);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      logger.warn('NotificationOnboarding', 'Failed to load onboarding state', { error: error.message });
      return null;
    }
  };

export const runSaveNotificationOnboardingState = async ({ SESSION_KEYS, SessionStorage, logger }, nextState = {}) => {
    try {
      await SessionStorage.multiSet([
        [SESSION_KEYS.NOTIFICATION_ONBOARDING, JSON.stringify(nextState)],
      ]);
    } catch (error) {
      logger.warn('NotificationOnboarding', 'Failed to persist onboarding state', { error: error.message });
    }
  };

export const runShouldShowNotificationOnboarding = async ({ NOTIFICATION_ONBOARDING_REMINDER_MS, loadNotificationOnboardingState, parseTimestampMs }, {
  userId,
  audience
}) => {
    const savedState = await loadNotificationOnboardingState();
    if (!savedState) return true;

    const sameUser = savedState?.userId && userId && savedState.userId === userId;
    const sameAudience = savedState?.audience === audience;
    const status = savedState?.status;

    if (status === 'completed' && sameUser && sameAudience) {
      return false;
    }

    if (status === 'skipped' && sameUser && sameAudience) {
      const skippedAtMs = parseTimestampMs(savedState?.updatedAt);
      if (Number.isFinite(skippedAtMs)) {
        return (Date.now() - skippedAtMs) >= NOTIFICATION_ONBOARDING_REMINDER_MS;
      }
      return false;
    }

    return true;
  };

export const runHandleNotificationOnboardingComplete = async ({ homeScreen, navigateTo, saveNotificationOnboardingState, user }, {
  status,
  audience,
  returnTo
}) => {
    const normalizedStatus = status === 'completed' ? 'completed' : 'skipped';
    await saveNotificationOnboardingState({
      status: normalizedStatus,
      audience,
      userId: user?.uid || null,
      updatedAt: new Date().toISOString(),
    });
    navigateTo(returnTo || homeScreen, { from: 'NotificationPreferences', onboardingCompleted: normalizedStatus === 'completed' });
  };
