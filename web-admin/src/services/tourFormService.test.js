import { describe, expect, it } from 'vitest';
import { parseTourPickupPointsText } from './tourFormService';

describe('parseTourPickupPointsText', () => {
  it('parses ASCII and en-dash separators without losing location punctuation', () => {
    expect(parseTourPickupPointsText([
      '06:30 - Dundee - Seagate Bus Station',
      '23:05 – Glasgow Buchanan Bus Station',
    ].join('\n'))).toEqual([
      { time: '06:30', location: 'Dundee - Seagate Bus Station' },
      { time: '23:05', location: 'Glasgow Buchanan Bus Station' },
    ]);
  });

  it('rejects malformed or impossible pickup times instead of saving blank app data', () => {
    expect(() => parseTourPickupPointsText('9:15 - Balloch')).toThrow(/HH:MM/);
    expect(() => parseTourPickupPointsText('29:75 - Balloch')).toThrow(/valid 24-hour time/);
    expect(() => parseTourPickupPointsText('09:15 Balloch')).toThrow(/HH:MM/);
  });

  it('allows an empty pickup point list', () => {
    expect(parseTourPickupPointsText(' \n ')).toEqual([]);
  });
});
