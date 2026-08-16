const PICKUP_POINT_LINE_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)\s*[-–]\s*(.{2,})$/;

export function parseTourPickupPointsText(value = '') {
  const lines = String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    const match = line.match(PICKUP_POINT_LINE_PATTERN);
    if (!match) {
      throw new Error(`Pickup point line ${index + 1} must use HH:MM - Location with a valid 24-hour time.`);
    }
    return {
      time: `${match[1]}:${match[2]}`,
      location: match[3].trim(),
    };
  });
}
