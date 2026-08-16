const REQUIRED_HEADERS = ['tour code', 'name'];

const normalizeHeader = (header = '') => header.replace(/^\uFEFF/, '').trim().toLowerCase();

const normalizeTourCode = (tourCode = '') => tourCode.trim().toUpperCase();

const UK_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isValidDateParts = (year, month, day) => {
  const date = new Date(year, month - 1, day);
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
};

export const isSupportedDateFormat = (value = '') => {
  const trimmed = value.trim();
  if (!trimmed) return true;

  const ukMatch = trimmed.match(UK_DATE_RE);
  if (ukMatch) {
    return isValidDateParts(Number(ukMatch[3]), Number(ukMatch[2]), Number(ukMatch[1]));
  }

  const isoMatch = trimmed.match(ISO_DATE_RE);
  if (isoMatch) {
    return isValidDateParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  return false;
};

export const parseCSVWithStateMachine = (csvContent = '') => {
  const rows = [];
  const parseErrors = [];

  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvContent.length; i += 1) {
    const char = csvContent[i];
    const next = csvContent[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') {
        i += 1;
      }
      row.push(field);
      const isBlankRow = row.every((cell) => !String(cell).trim());
      if (!isBlankRow) rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    parseErrors.push('Malformed CSV: unmatched quote detected.');
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    const isBlankRow = row.every((cell) => !String(cell).trim());
    if (!isBlankRow) rows.push(row);
  }

  return { rows, parseErrors };
};

const normalizeDateForStorage = (value = '') => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const isoMatch = trimmed.match(ISO_DATE_RE);
  if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  return trimmed;
};

const parseBoolean = (value, fallback = true) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['yes', 'true', '1'].includes(normalized)) return true;
  if (['no', 'false', '0'].includes(normalized)) return false;
  return null;
};

const normalizePickupPoint = (point) => {
  if (!point || typeof point !== 'object' || Array.isArray(point)) return null;
  const location = String(point.location || '').trim();
  const time = String(point.time || '').trim();
  const date = String(point.date || '').trim();
  if (!location || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  return date ? { location, time, date } : { location, time };
};

export const parsePickupPointsCell = (value = '') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return { value: [], error: null };

  if (trimmed.startsWith('[')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (!Array.isArray(decoded)) throw new Error('not an array');
      const points = decoded.map(normalizePickupPoint);
      if (points.some((point) => !point)) throw new Error('invalid pickup point');
      return { value: points, error: null };
    } catch {
      return { value: [], error: 'Pickup Points JSON must be an array of {location, time} objects.' };
    }
  }

  const points = trimmed.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const match = entry.match(/^((?:[01]\d|2[0-3]):[0-5]\d)\s+-\s+(.+)$/);
    return match ? { time: match[1], location: match[2].trim() } : null;
  });
  if (points.some((point) => !point || !point.location)) {
    return { value: [], error: 'Pickup Points must be JSON or semicolon-separated entries such as 08:00 - Balloch.' };
  }
  return { value: points, error: null };
};

export const validateTourCsvRows = (csvContent, options = {}) => {
  const {
    mode = 'upsert',
    existingTourCodes = new Set(),
    existingTourCodeToId = new Map(),
    existingDrivers = new Map(),
  } = options;

  const { rows, parseErrors } = parseCSVWithStateMachine(csvContent || '');
  if (rows.length === 0) {
    return {
      rows: [],
      parseErrors: parseErrors.length > 0 ? parseErrors : ['CSV file is empty.'],
      summary: { total: 0, valid: 0, invalid: 0, warnings: 0 },
    };
  }

  const headers = rows[0].map(normalizeHeader);
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  const getHeaderIndex = (...variants) => variants.map(normalizeHeader).map((header) => headers.indexOf(header)).find((index) => index >= 0) ?? -1;
  const hasHeader = (...variants) => getHeaderIndex(...variants) >= 0;
  const driverExists = (driverId) => (
    existingDrivers instanceof Map ? existingDrivers.has(driverId) : existingDrivers.has?.(driverId)
  );
  const getDriverProfile = (driverId) => (
    existingDrivers instanceof Map ? existingDrivers.get(driverId) : null
  );

  const fileCodeCounts = new Map();
  const previewRows = [];

  for (let i = 1; i < rows.length; i += 1) {
    const sourceRow = rows[i];
    const rowNumber = i + 1;
    const errors = [];
    const warnings = [];

    const getValue = (...headerVariants) => {
      for (const header of headerVariants) {
        const index = headers.indexOf(normalizeHeader(header));
        if (index >= 0) return String(sourceRow[index] ?? '').trim();
      }
      return '';
    };

    const tourCode = getValue('tour code', 'tourcode');
    const name = getValue('name');
    const daysRaw = getValue('days');
    const maxParticipantsRaw = getValue('max participants', 'maxparticipants');
    const startDate = getValue('start date', 'startdate');
    const endDate = getValue('end date', 'enddate');
    const activeRaw = getValue('active', 'isactive');
    const driverName = getValue('driver', 'drivername');
    const driverId = getValue('driver id', 'driverid').toUpperCase();
    const driverPhone = getValue('driver phone', 'driverphone');
    const pickupPointsRaw = getValue('pickup points', 'pickuppoints');

    if (sourceRow.length > headers.length) {
      errors.push(`Unexpected extra columns detected (${sourceRow.length - headers.length}).`);
    }

    if (missingHeaders.length > 0) {
      errors.push(`Missing required CSV headers: ${missingHeaders.join(', ')}.`);
    }

    if (!name) errors.push('Name is required.');
    if (!tourCode) errors.push('Tour code is required.');

    if (startDate && !isSupportedDateFormat(startDate)) {
      errors.push('Start Date must be dd/MM/yyyy or yyyy-MM-dd.');
    }
    if (endDate && !isSupportedDateFormat(endDate)) {
      errors.push('End Date must be dd/MM/yyyy or yyyy-MM-dd.');
    }

    const active = parseBoolean(activeRaw, true);
    if (active === null) {
      errors.push('Active must be Yes, No, True, False, 1, or 0.');
    }

    const pickupPointsResult = parsePickupPointsCell(pickupPointsRaw);
    if (hasHeader('pickup points', 'pickuppoints') && pickupPointsResult.error) {
      errors.push(pickupPointsResult.error);
    }

    const parseNumeric = (value, fallback) => {
      if (!value) return fallback;
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? NaN : parsed;
    };

    const days = parseNumeric(daysRaw, 1);
    const maxParticipants = parseNumeric(maxParticipantsRaw, 53);
    // Participant totals are derived from server-confirmed booking records. The
    // exported column is useful for reporting, but importing it must never
    // overwrite the trusted count used by the passenger and driver apps.
    const currentParticipants = 0;

    if (Number.isNaN(days) || days < 1 || days > 60) {
      errors.push('Days must be an integer between 1 and 60.');
    }
    if (Number.isNaN(maxParticipants) || maxParticipants < 1 || maxParticipants > 500) {
      errors.push('Max Participants must be an integer between 1 and 500.');
    }
    if (hasHeader('current participants', 'currentparticipants')) {
      warnings.push('Current Participants is read-only and was ignored; confirmed passenger bookings manage this count.');
    }

    const normalizedCode = normalizeTourCode(tourCode);
    if (normalizedCode) {
      fileCodeCounts.set(normalizedCode, (fileCodeCounts.get(normalizedCode) || 0) + 1);
    }

    const existsInDb = normalizedCode ? existingTourCodes.has(normalizedCode) : false;
    let action = 'create';
    if (mode === 'create-only') {
      if (existsInDb) {
        errors.push(`Tour code ${tourCode} already exists in database (create-only mode).`);
      }
      action = 'create';
    } else if (mode === 'update-existing') {
      if (!existsInDb) {
        errors.push(`Tour code ${tourCode} does not exist in database (update-existing mode).`);
      }
      action = 'update';
    } else {
      action = existsInDb ? 'update' : 'create';
    }

    let assignment = null;
    if (hasHeader('driver id', 'driverid')) {
      if (driverId) {
        if (!driverExists(driverId)) {
          errors.push(`Driver ID ${driverId} does not exist.`);
        } else {
          const profile = getDriverProfile(driverId) || {};
          assignment = {
            action: 'assign',
            driverId,
            driverInfo: {
              name: String(profile.name || driverName || driverId).trim(),
              phone: String(profile.phone || driverPhone || '').trim(),
              authUid: String(profile.authUid || '').trim(),
            },
          };
          if (driverName && profile.name && driverName !== profile.name) {
            warnings.push(`Driver name comes from profile ${driverId}; the CSV value will not overwrite it.`);
          }
          if (driverPhone && profile.phone && driverPhone !== profile.phone) {
            warnings.push(`Driver phone comes from profile ${driverId}; the CSV value will not overwrite it.`);
          }
        }
      } else if (action === 'update') {
        assignment = { action: 'unassign' };
      }
    } else if ((driverName && driverName.toUpperCase() !== 'TBA') || driverPhone) {
      warnings.push('Driver display columns are ignored without a Driver ID column; assignments must use an existing driver profile.');
    }

    const updates = {
      name,
      tourCode,
    };
    if (hasHeader('days')) updates.days = days;
    if (hasHeader('start date', 'startdate')) updates.startDate = normalizeDateForStorage(startDate);
    if (hasHeader('end date', 'enddate')) updates.endDate = normalizeDateForStorage(endDate);
    if (hasHeader('active', 'isactive')) updates.isActive = active;
    if (hasHeader('max participants', 'maxparticipants')) updates.maxParticipants = maxParticipants;
    if (hasHeader('pickup points', 'pickuppoints')) updates.pickupPoints = pickupPointsResult.value;

    previewRows.push({
      rowNumber,
      sourceRow,
      action,
      existsInDb,
      normalizedCode,
      errors,
      warnings,
      updates,
      assignment,
      tour: {
        name,
        tourCode,
        days,
        startDate: normalizeDateForStorage(startDate),
        endDate: normalizeDateForStorage(endDate),
        isActive: active ?? true,
        driverName: 'TBA',
        driverPhone: '',
        maxParticipants,
        currentParticipants,
        pickupPoints: pickupPointsResult.value,
        itinerary: { title: name || '', days: [] },
      },
      existingTourId: existingTourCodeToId.get(normalizedCode) || null,
    });
  }

  for (const row of previewRows) {
    if (row.normalizedCode && fileCodeCounts.get(row.normalizedCode) > 1) {
      row.errors.push(`Duplicate tour code ${row.tour.tourCode} in CSV file.`);
    }
    row.isValid = row.errors.length === 0;
  }

  const valid = previewRows.filter((row) => row.isValid).length;

  return {
    rows: previewRows,
    parseErrors,
    summary: {
      total: previewRows.length,
      valid,
      invalid: previewRows.length - valid,
      warnings: previewRows.reduce((total, row) => total + row.warnings.length, 0),
    },
  };
};
