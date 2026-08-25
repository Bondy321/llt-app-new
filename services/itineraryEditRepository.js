import { auth, realtimeDb } from '../firebase';
import { saveItineraryWithConflictGuard } from './itineraryService';

export const saveItineraryDraft = ({ draft, expectedContentSignature, tourId }) => (
  saveItineraryWithConflictGuard({
    tourId,
    draft,
    expectedContentSignature,
    updatedBy: auth?.currentUser?.uid || 'driver',
    db: realtimeDb,
  })
);
