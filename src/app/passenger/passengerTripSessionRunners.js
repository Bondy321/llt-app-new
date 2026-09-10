export const handlePassengerTripSessionInvalid = async ({ appSession, purgeLocalSession, appSessionService, setLogoutStatus }) => {
  if (!appSession) return;
  setLogoutStatus({ state: 'requesting', error: null, diagnostic: null });
  const result = await purgeLocalSession({ capturedSession: appSession });
  if (result.success) {
    await appSessionService.completeEnd();
    setLogoutStatus({ state: 'complete', error: null, diagnostic: null });
  } else setLogoutStatus({ state: 'failed', error: 'Your session ended. Please try removing the saved data again.', diagnostic: null });
};
