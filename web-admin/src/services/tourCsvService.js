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

export const validateTourCsvRows = (csvContent, options = {}) => {
  const {
    mode = 'upsert',
    existingTourCodes = new Set(),
    existingTourCodeToId = new Map(),
  } = options;

  const { rows, parseErrors } = parseCSVWithStateMachine(csvContent || '');
  if (rows.length === 0) {
    return {
      rows: [],
      parseErrors: parseErrors.length > 0 ? parseErrors : ['CSV file is empty.'],
      summary: { total: 0, valid: 0, invalid: 0 },
    };
  }

  const headers = rows[0].map(normalizeHeader);
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));

  const fileCodeCounts = new Map();
  const previewRows = [];

  for (let i = 1; i < rows.length; i += 1) {
    const sourceRow = rows[i];
    const rowNumber = i + 1;
    const errors = [];

    const getValue = (...headerVariants) => {
      for (const header of headerVariants) {
        const index = headers.indexOf(header);
        if (index >= 0) return String(sourceRow[index] ?? '').trim();
      }
      return '';
    };

    const tourCode = getValue('tour code', 'tourcode');
    const name = getValue('name');
    const daysRaw = getValue('days');
    const maxParticipantsRaw = getValue('max participants', 'maxparticipants');
    const currentParticipantsRaw = getValue('current participants', 'currentparticipants');
    const startDate = getValue('start date', 'startdate');
    const endDate = getValue('end date', 'enddate');
    const activeRaw = getValue('active', 'isactive');
    const driverName = getValue('driver', 'drivername');
    const driverPhone = getValue('driver phone', 'driverphone');

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

    const parseNumeric = (value, fallback) => {
      if (!value) return fallback;
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? NaN : parsed;
    };

    const days = parseNumeric(daysRaw, 1);
    const maxParticipants = parseNumeric(maxParticipantsRaw, 53);
    const currentParticipants = parseNumeric(currentParticipantsRaw, 0);

    if (Number.isNaN(days) || days < 1 || days > 60) {
      errors.push('Days must be an integer between 1 and 60.');
    }
    if (Number.isNaN(maxParticipants) || maxParticipants < 1 || maxParticipants > 500) {
      errors.push('Max Participants must be an integer between 1 and 500.');
    }
    if (Number.isNaN(currentParticipants) || currentParticipants < 0 || currentParticipants > 500) {
      errors.push('Current Participants must be an integer between 0 and 500.');
    }
    if (!Number.isNaN(maxParticipants) && !Number.isNaN(currentParticipants) && currentParticipants > maxParticipants) {
      errors.push('Current Participants cannot exceed Max Participants.');
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

    previewRows.push({
      rowNumber,
      sourceRow,
      action,
      existsInDb,
      normalizedCode,
      errors,
      tour: {
        name,
        tourCode,
        days,
        startDate,
        endDate,
        isActive: activeRaw ? activeRaw.toLowerCase() === 'yes' || activeRaw.toLowerCase() === 'true' : true,
        driverName: driverName || 'TBA',
        driverPhone,
        maxParticipants,
        currentParticipants,
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
    },
  };
};
