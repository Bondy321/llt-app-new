import { classifySessionTransition } from '../../../services/appSessionTransition';

// Session-only revisions do not change passenger membership, navigation or
// operational scope. Accept in memory before awaiting persistence so two rapid
// revisions remain ordered, and guard both the storage batch and late result.
export const runHandleSessionRevisionChange = async (deps, event) => {
  if (event.session?.principalType === 'driver') return deps.reconcileDriverSession(event);
  const { appSessionRef, appSessionService, getCurrentContext, setAppSession } = deps;
  const expected = appSessionRef.current;
  const context = getCurrentContext();
  const change = classifySessionTransition(expected, event.session);
  if (!context.active || !event.authUid || event.authUid !== context.userUid
    || !['advance', 'duplicate'].includes(change)) return { ignored: true };
  const session = change === 'duplicate' ? expected : event.session;
  const isCurrent = () => appSessionRef.current === session && getCurrentContext().active
    && getCurrentContext().userUid === event.authUid;
  if (change === 'advance') setAppSession(session);
  const committed = await appSessionService.persistSessionTransition({
    expectedSession: expected, session, projectionEntries: [], isCurrent,
  });
  return committed && isCurrent() ? { session } : { ignored: true };
};
