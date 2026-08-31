import { runDriverLogin } from '../driver/driverLoginRunner';
import { runPassengerLogin } from '../passenger/passengerLoginRunner';
import {
  activateVerifiedSession,
  prepareLoginContext,
  resolvePostLoginDestination,
} from './loginSessionPhases';
import defaultAccountDeletionService from '../../../services/accountDeletionService';

export const runResolveOfflineLogin = async (deps, reference, normalizedEmail) => {
  const {
    SESSION_KEYS,
    SessionStorage,
    appSessionService,
    logger,
    maskIdentifier,
    offlineSyncService,
    resolveOfflineLoginFromCache,
  } = deps;
  const accountDeletionService = deps.accountDeletionService || defaultAccountDeletionService;
  if (await accountDeletionService.readPending()) {
    return { success: false, reason: 'ACCOUNT_DELETION_IN_PROGRESS', error: 'Account deletion must finish before this device can open a tour.' };
  }
  if (await appSessionService.readPendingEnd()) {
    return { success: false, reason: 'LOGOUT_PENDING', error: 'Logout must finish online before this device can reopen a tour.' };
  }
  const cachedAppSession = await appSessionService.readSession();
  if (!cachedAppSession) {
    return { success: false, reason: 'ONLINE_VERIFICATION_REQUIRED', error: 'Connect to the internet to start a secure tour session.' };
  }
  const result = await resolveOfflineLoginFromCache({
    reference,
    normalizedEmail,
    sessionStorage: SessionStorage,
    sessionKeys: SESSION_KEYS,
    offlineSyncService,
    maskIdentifier,
    logger,
  });
  if (!result || !result.success) return result;
  const identity = result.identity || {};
  const tour = result.tour || {};
  const identityId = result.type === 'driver' ? identity.id : identity.stablePassengerId;
  const expectedPrincipalId = result.type === 'driver' ? `driver:${identityId}` : identityId;
  const expectedTourId = tour.id || identity.assignedTourId || null;
  const matchesScope = cachedAppSession.principalType === result.type
    && cachedAppSession.principalId === expectedPrincipalId
    && cachedAppSession.tourId === expectedTourId;
  if (!matchesScope) {
    return { success: false, reason: 'SESSION_SCOPE_MISMATCH', error: 'Saved tour data no longer matches this secure session. Reconnect to sign in.' };
  }
  return { ...result, appSession: cachedAppSession };
};

export const runHandleLoginSuccess = async (
  deps,
  reference,
  tourDetails,
  bookingOrDriverData,
  userType = 'passenger',
  options = {},
) => {
  const accountDeletionService = deps.accountDeletionService || defaultAccountDeletionService;
  if (await accountDeletionService.readPending()) {
    const error = new Error('Account deletion must finish before another tour can be opened.');
    error.code = 'ACCOUNT_DELETION_IN_PROGRESS';
    throw error;
  }
  const context = await prepareLoginContext(
    deps,
    reference,
    tourDetails,
    bookingOrDriverData,
    userType,
    options,
  );
  await activateVerifiedSession(deps, context);
  const destination = await resolvePostLoginDestination(deps, context);
  if (userType === 'driver') {
    await runDriverLogin(deps, context, destination);
    return;
  }
  await runPassengerLogin(deps, context, destination);
};
