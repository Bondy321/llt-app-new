import { auth } from '../firebase';
import {
  formatDateToUK,
  parseISODateStrict,
  parseUKDateStrict,
} from '../utils/dateUtils';

const BOOKING_REFERENCE_PATTERN = /^[A-Z0-9_-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE_PATTERN = /^[+()\d\s-]+$/;

export const createEmptyPassenger = () => ({
  name: '',
  seatNumber: '',
  phone: '',
});

export const createEmptyPassengerDraft = (tourId = '') => ({
  tourId,
  bookingRef: '',
  email: '',
  pickupDate: '',
  pickupTime: '',
  pickupLocation: '',
  passengers: [createEmptyPassenger()],
});

const parseTourDate = (value) => {
  const uk = parseUKDateStrict(value);
  if (uk.success) return uk.date;
  const iso = parseISODateStrict(value);
  return iso.success ? iso.date : null;
};

const getPhoneDigitCount = (value) => (String(value || '').match(/\d/g) || []).length;

export const validateManualPassengerDraft = (draft, tours = {}) => {
  const errors = {};
  const tour = tours[draft?.tourId] || null;
  const bookingRef = String(draft?.bookingRef || '').trim().toUpperCase();
  const email = String(draft?.email || '').trim().toLowerCase();
  const pickupLocation = String(draft?.pickupLocation || '').trim();
  const pickupTime = String(draft?.pickupTime || '').trim();
  const pickupDateResult = parseISODateStrict(draft?.pickupDate || '');
  const passengers = Array.isArray(draft?.passengers) ? draft.passengers : [];

  if (!tour) {
    errors.tourId = 'Select an existing tour.';
  } else if (tour.isActive === false) {
    errors.tourId = 'Passengers can only be added to active tours.';
  }

  if (
    !bookingRef
    || bookingRef.length > 64
    || bookingRef.startsWith('D-')
    || !BOOKING_REFERENCE_PATTERN.test(bookingRef)
  ) {
    errors.bookingRef = 'Use letters, numbers, hyphens, or underscores (not a driver code).';
  }

  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    errors.email = 'Enter a valid email address.';
  }

  if (!pickupDateResult.success) {
    errors.pickupDate = 'Select a valid pickup date.';
  } else if (tour) {
    const startDate = parseTourDate(tour.startDate);
    const endDate = parseTourDate(tour.endDate || tour.startDate);
    if (!startDate || !endDate) {
      errors.pickupDate = 'This tour has invalid dates and must be fixed first.';
    } else if (
      pickupDateResult.date.getTime() < startDate.getTime()
      || pickupDateResult.date.getTime() > endDate.getTime()
    ) {
      errors.pickupDate = 'Pickup date must fall within the selected tour dates.';
    }
  }

  if (!TIME_PATTERN.test(pickupTime)) {
    errors.pickupTime = 'Enter a valid 24-hour time.';
  }
  if (pickupLocation.length < 3 || pickupLocation.length > 250) {
    errors.pickupLocation = 'Enter a pickup location between 3 and 250 characters.';
  }
  if (passengers.length < 1 || passengers.length > 53) {
    errors.passengers = 'Add between 1 and 53 passengers.';
  }

  const maxParticipants = Number.isInteger(tour?.maxParticipants) && tour.maxParticipants > 0
    ? tour.maxParticipants
    : 53;
  const seenSeats = new Set();
  const passengerErrors = passengers.map((passenger) => {
    const rowErrors = {};
    const name = String(passenger?.name || '').trim();
    const phone = String(passenger?.phone || '').trim();
    const seatNumber = Number(passenger?.seatNumber);

    if (name.length < 2 || name.length > 120) {
      rowErrors.name = 'Enter the passenger full name.';
    }
    if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > maxParticipants) {
      rowErrors.seatNumber = `Seat must be between 1 and ${maxParticipants}.`;
    } else if (seenSeats.has(seatNumber)) {
      rowErrors.seatNumber = `Seat ${seatNumber} is already used in this booking.`;
    } else {
      seenSeats.add(seatNumber);
    }
    if (
      !phone
      || phone.length > 40
      || !PHONE_PATTERN.test(phone)
      || getPhoneDigitCount(phone) < 7
    ) {
      rowErrors.phone = 'Enter a valid phone number with at least 7 digits.';
    }
    return rowErrors;
  });

  if (passengerErrors.some((row) => Object.keys(row).length > 0)) {
    errors.passengerRows = passengerErrors;
  }

  const normalizedPassengers = passengers.map((passenger) => ({
    name: String(passenger?.name || '').trim(),
    seatNumber: Number(passenger?.seatNumber),
    phone: String(passenger?.phone || '').trim(),
  }));

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized: {
      tourId: draft?.tourId || '',
      bookingRef,
      email,
      pickupDate: pickupDateResult.success ? formatDateToUK(pickupDateResult.date) : '',
      pickupTime,
      pickupLocation,
      passengers: normalizedPassengers,
    },
  };
};

const buildCreateManualPassengerUrl = () => {
  const explicitUrl = import.meta.env.VITE_CREATE_MANUAL_PASSENGER_URL?.trim();
  if (explicitUrl) return explicitUrl;

  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;
  return `https://europe-west1-${projectId}.cloudfunctions.net/createManualPassengerBooking`;
};

const REASON_MESSAGES = {
  ORIGIN_NOT_ALLOWED: 'This admin portal address is not authorized for passenger creation. Contact an administrator before retrying.',
  INVALID_CREDENTIALS: 'Your admin session has expired. Sign in again and retry.',
  NOT_AUTHORIZED: 'This account is not authorized to add passengers.',
  TRY_AGAIN_LATER: 'Too many requests were made. Wait a moment and retry.',
  INVALID_INPUT: 'Some passenger details are invalid. Review every field and retry.',
  INVALID_TOUR: 'Select a valid tour.',
  TOUR_NOT_FOUND: 'The selected tour no longer exists.',
  TOUR_INACTIVE: 'Passengers can only be added to active tours.',
  TOUR_IDENTITY_MISMATCH: 'The selected tour has inconsistent identity data and must be fixed first.',
  TOUR_DATES_INVALID: 'The selected tour has invalid dates and must be fixed first.',
  INVALID_BOOKING_REFERENCE: 'The booking reference is invalid.',
  BOOKING_REFERENCE_EXISTS: 'That booking reference is already in use.',
  INVALID_EMAIL: 'The passenger email address is invalid.',
  INVALID_PICKUP_DATE: 'The pickup date is invalid.',
  PICKUP_DATE_OUTSIDE_TOUR: 'The pickup date must fall within the selected tour dates.',
  INVALID_PICKUP_TIME: 'The pickup time is invalid.',
  INVALID_PICKUP_LOCATION: 'The pickup location is invalid.',
  INVALID_PASSENGERS: 'The booking must contain at least one valid passenger.',
  INVALID_PASSENGER_NAME: 'One or more passenger names are invalid.',
  INVALID_SEAT_NUMBER: 'One or more seat numbers are invalid.',
  DUPLICATE_SEAT_IN_BOOKING: 'A seat number is duplicated within this booking.',
  SEAT_ALREADY_ASSIGNED: 'One or more selected seats are already assigned on this tour.',
  TOUR_CAPACITY_EXCEEDED: 'This booking would exceed the selected tour capacity.',
  INVALID_PHONE: 'One or more passenger phone numbers are invalid.',
  CREATE_IN_PROGRESS: 'Another booking is currently being added. Wait a moment and retry.',
  INTERNAL_ERROR: 'The passenger could not be added safely. No partial booking was created.',
};

export const createManualPassengerBooking = async (draft, tours = {}) => {
  const validation = validateManualPassengerDraft(draft, tours);
  if (!validation.valid) {
    const error = new Error('Complete every required field before adding the passenger.');
    error.code = 'CLIENT_VALIDATION_FAILED';
    error.validation = validation;
    throw error;
  }

  const endpoint = buildCreateManualPassengerUrl();
  if (!endpoint) {
    throw new Error('Manual passenger creation is not configured for this web admin deployment.');
  }
  if (!auth.currentUser) {
    throw new Error('Your admin session has expired. Sign in again and retry.');
  }

  const token = await auth.currentUser.getIdToken();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(validation.normalized),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const reason = payload?.reason || 'INTERNAL_ERROR';
    const error = new Error(REASON_MESSAGES[reason] || REASON_MESSAGES.INTERNAL_ERROR);
    error.code = reason;
    throw error;
  }

  return payload;
};
