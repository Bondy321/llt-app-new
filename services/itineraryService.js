const { normalizeTourId } = require('./tourIdentityService');

const MAX_ITINERARY_DAYS = 60;
const MAX_DAY_CONTENT_LENGTH = 12000;
const MAX_ITINERARY_BYTES = 250000;
const METADATA_KEYS = new Set(['revision', 'updatedAt', 'updatedBy']);

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .filter((key) => !METADATA_KEYS.has(key))
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
};

const createItineraryContentSignature = (itinerary) => JSON.stringify(canonicalize(itinerary ?? null));

const normalizeRevision = (value) => (
  Number.isInteger(value) && value >= 0 ? value : 0
);

const validateItineraryDraft = (draft) => {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return { valid: false, error: 'The itinerary is not in a supported format.' };
  }
  if (!Array.isArray(draft.days) || draft.days.length < 1) {
    return { valid: false, error: 'Add at least one itinerary day before saving.' };
  }
  if (draft.days.length > MAX_ITINERARY_DAYS) {
    return { valid: false, error: `An itinerary can contain up to ${MAX_ITINERARY_DAYS} days.` };
  }
  if (typeof draft.title === 'string' && draft.title.trim().length > 200) {
    return { valid: false, error: 'The itinerary title is too long.' };
  }

  for (let index = 0; index < draft.days.length; index += 1) {
    const day = draft.days[index];
    if (!day || typeof day !== 'object' || Array.isArray(day)) {
      return { valid: false, error: `Day ${index + 1} is not in a supported format.` };
    }
    if (typeof day.content !== 'string') {
      return { valid: false, error: `Day ${index + 1} needs itinerary text, even if it is currently blank.` };
    }
    if (day.content.length > MAX_DAY_CONTENT_LENGTH) {
      return { valid: false, error: `Day ${index + 1} is too long. Shorten it before saving.` };
    }
  }

  const byteLength = JSON.stringify(draft).length;
  if (byteLength > MAX_ITINERARY_BYTES) {
    return { valid: false, error: 'This itinerary is too large to save safely.' };
  }
  return { valid: true, error: null };
};

const buildItineraryDocument = ({ draft, current, updatedBy, now }) => {
  const safeDraft = cloneJson(draft);
  return {
    ...safeDraft,
    title: typeof safeDraft.title === 'string' ? safeDraft.title.trim() : '',
    days: safeDraft.days.map((day, index) => ({
      ...day,
      day: index + 1,
      content: day.content,
    })),
    revision: normalizeRevision(current?.revision) + 1,
    updatedAt: now,
    updatedBy: String(updatedBy || 'driver').slice(0, 128),
  };
};

const saveItineraryWithConflictGuard = async ({
  tourId,
  draft,
  expectedContentSignature,
  updatedBy,
  db,
  now = Date.now(),
}) => {
  const normalizedTourId = normalizeTourId(tourId);
  if (!normalizedTourId || !db) throw new Error('Itinerary service is unavailable');

  const validation = validateItineraryDraft(draft);
  if (!validation.valid) {
    return { success: false, validationError: validation.error };
  }

  let observedServerValue = null;
  const ref = db.ref(`tours/${normalizedTourId}/itinerary`);
  const transactionResult = await ref.transaction((current) => {
    observedServerValue = current || null;
    if (typeof expectedContentSignature !== 'string'
      || createItineraryContentSignature(current || null) !== expectedContentSignature) {
      return undefined;
    }
    return buildItineraryDocument({ draft, current, updatedBy, now });
  });

  if (!transactionResult?.committed) {
    return {
      success: false,
      conflict: true,
      serverItinerary: transactionResult?.snapshot?.val?.() || observedServerValue,
    };
  }

  return {
    success: true,
    itinerary: transactionResult.snapshot?.val?.()
      || buildItineraryDocument({ draft, current: observedServerValue, updatedBy, now }),
  };
};

module.exports = {
  MAX_ITINERARY_DAYS,
  buildItineraryDocument,
  createItineraryContentSignature,
  saveItineraryWithConflictGuard,
  validateItineraryDraft,
};
