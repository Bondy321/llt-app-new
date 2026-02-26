import { parseISODateStrict, parseUKDateStrict } from '../utils/dateUtils.js';

const isTourAssigned = (tour = {}) => Boolean(tour.driverName && tour.driverName !== 'TBA');

const parseSupportedTourDate = (startDate) => {
  const ukParsed = parseUKDateStrict(startDate);
  if (ukParsed.success) return ukParsed;

  const isoParsed = parseISODateStrict(startDate);
  if (isoParsed.success) return isoParsed;

  return {
    success: false,
    error: {
      code: 'UNSUPPORTED_FORMAT',
      message: 'Tour startDate must be dd/MM/yyyy or yyyy-MM-dd.',
      input: startDate,
      expectedFormat: 'dd/MM/yyyy | yyyy-MM-dd',
    },
  };
};

export const buildUnassignedTourTriage = (
  tours,
  {
    today = new Date(),
    maxUpcomingDays = 7,
    maxActionableItems = 5,
  } = {},
) => {
  const normalizedToday = new Date(today);
  normalizedToday.setHours(0, 0, 0, 0);

  const cutoffDate = new Date(normalizedToday);
  cutoffDate.setDate(normalizedToday.getDate() + maxUpcomingDays);

  const actionable = [];
  const warnings = [];

  Object.entries(tours || {}).forEach(([id, tour]) => {
    if (isTourAssigned(tour)) return;

    const parsed = parseSupportedTourDate(tour?.startDate);
    if (!parsed.success) {
      warnings.push({
        id,
        name: tour?.name || id,
        startDate: tour?.startDate,
        participants: tour?.currentParticipants || 0,
        warningCode: parsed.error.code,
      });
      return;
    }

    if (parsed.date > cutoffDate) return;

    const dayDelta = Math.ceil((parsed.date - normalizedToday) / (1000 * 60 * 60 * 24));
    actionable.push({
      id,
      name: tour?.name || id,
      startDate: tour?.startDate,
      participants: tour?.currentParticipants || 0,
      dayDelta,
      parsedDate: parsed.date,
    });
  });

  return {
    actionable: actionable
      .sort((a, b) => a.parsedDate - b.parsedDate)
      .slice(0, maxActionableItems),
    warnings: warnings.sort((a, b) => a.name.localeCompare(b.name)),
  };
};

