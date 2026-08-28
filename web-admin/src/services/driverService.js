import { ref, runTransaction, update } from 'firebase/database';
import { db } from '../firebase';
import { nowAsISOString } from '../utils/dateUtils';

const FIREBASE_KEY_INVALID_PATTERN = /[.#$[\]/]/g;

export const normalizeDriverId = (code) => {
  const normalized = String(code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(FIREBASE_KEY_INVALID_PATTERN, '');
  if (!normalized) return '';
  return normalized.startsWith('D-') ? normalized : `D-${normalized}`;
};

export async function createDriver({ name, code, phone = '' }) {
  const normalizedName = String(name || '').trim();
  const driverId = normalizeDriverId(code);
  if (!normalizedName) throw new Error('Driver name is required.');
  if (!driverId || driverId === 'D-') throw new Error('Enter a valid driver code.');

  const driver = {
    id: driverId,
    name: normalizedName,
    phone: String(phone || '').trim(),
    createdAt: nowAsISOString(),
  };
  const transaction = await runTransaction(
    ref(db, `drivers/${driverId}`),
    (existing) => (existing === null ? driver : undefined),
    { applyLocally: false },
  );

  if (!transaction.committed) {
    const error = new Error(`Driver code ${driverId} is already in use. Choose a different code.`);
    error.code = 'DRIVER_CODE_EXISTS';
    throw error;
  }

  return { id: driverId, driver };
}

export const updateDriverContactProjection = ({ driverId, name, phone = '' }) => {
  if (!driverId) throw new Error('Driver ID is required.');
  return update(ref(db), {
    [`drivers/${driverId}/name`]: String(name || '').trim(),
    [`drivers/${driverId}/phone`]: String(phone || '').trim(),
  });
};
