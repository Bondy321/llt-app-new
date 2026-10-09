// Explicit presentation-only sample data. Never written to Firebase.
export function demoCoachRows(nowMs) {
  const definitions = [
    ['Loch Lomond day tour', 'Alex', 56.00265, -4.5835, 45_000, 12],
    ['Edinburgh city break', 'Jamie', 55.953, -3.188, 110_000, 18],
    ['Highlands & Inverness', 'Morgan', 57.477, -4.224, 7 * 60_000, 35],
    ['Lake District weekend', 'Sam', 54.328, -2.747, 15 * 60_000, 25],
    ['Glasgow departure', 'Taylor', 55.864, -4.252, 65_000, 850],
    ['Stirling sightseeing', 'Casey', 56.116, -3.936, 35 * 60_000, 15],
    ['A second Edinburgh coach', 'Drew', 55.953, -3.188, 80_000, 20],
    ['Oban coastal tour', 'Robin', 56.414, -5.472, null, null],
  ];
  return Object.fromEntries(definitions.map(([name, driver, latitude, longitude, age, accuracy], index) => {
    const tourId = `DEMO-${String(index + 1).padStart(2, '0')}`;
    const fixed = { schemaVersion: 1, mode: 'pickup', source: 'manual', isSharing: true,
      latitude: 56.415, longitude: -5.471, timestamp: nowMs - 60 * 60_000, address: 'Sample harbour pickup point' };
    return [tourId, { schemaVersion: 1, tourId, tourCode: tourId, name, isActive: true,
      startAtMs: nowMs - 60 * 60_000, endAtMs: nowMs + 8 * 60 * 60_000,
      assignedDrivers: [{ driverId: `DEMO-DRIVER-${index + 1}`, name: `${driver} (demo)` }], assignmentOverflow: false,
      location: age === null ? fixed : { schemaVersion: 1, mode: 'live', source: 'auto', isSharing: true,
        latitude, longitude, timestamp: nowMs - age, accuracy }, updatedAtMs: nowMs }];
  }));
}
