import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoachMap } from '../features/coach-tracking/map/createCoachMap';
const maps = [];
const elements = [];
const make = () => {
  const element = document.createElement('div');
  Object.defineProperties(element, { clientWidth: { value: 800 }, clientHeight: { value: 480 } });
  document.body.append(element); elements.push(element);
  const onSelect = vi.fn(); const map = createCoachMap(element, { onSelect }); maps.push(map);
  return { element, map, onSelect };
};
const row = (tourId, latitude = 56, longitude = -4) => ({ tourId, tourCode: tourId, name: 'Tour',
  state: 'live', meta: { label: 'Live' }, position: { latitude, longitude }, pickup: null });
afterEach(() => { maps.splice(0).forEach(map => map.destroy()); elements.splice(0).forEach(element => element.remove()); });

describe('real Leaflet renderer lifecycle', () => {
  it('renders overlapping positions as a discoverable cluster with individual tour choices', () => {
    const { element, map, onSelect } = make(); map.update([row('A'), row('B')], null, false);
    const cluster = element.querySelector('[title="2 tour positions nearby. Choose a tour."]');
    expect(cluster).not.toBeNull(); cluster.click();
    const buttons = [...element.querySelectorAll('.coach-map-cluster-list button')];
    expect(buttons.map(button => button.textContent)).toEqual(['A · Live', 'B · Live']);
    buttons[1].click(); expect(onSelect).toHaveBeenCalledWith('B');
  });
  it('keeps fixed pickup markers separate and clears withdrawn positions without rebuilding the map', () => {
    const { element, map } = make(); const item = { ...row('A'), pickup: { latitude: 56.5, longitude: -4.5, address: 'Meeting place' } };
    map.update([item], null, false); expect(element.querySelectorAll('.coach-map-pin--pickup')).toHaveLength(0);
    map.update([item], 'A', true); expect(element.querySelectorAll('.coach-map-pin--pickup')).toHaveLength(1);
    map.update([], null, true); expect(element.querySelectorAll('.coach-map-pin')).toHaveLength(0);
  });
  it('does not interpret untrusted tour codes as HTML and releases ownership for remount', () => {
    const { element, map } = make(); const hostile = '<img src=x onerror=alert(1)>';
    map.update([{ ...row('A'), tourCode: hostile }], 'A', false);
    expect(element.querySelector('[onerror]')).toBeNull();
    map.destroy(); maps.pop();
    const replacement = createCoachMap(element, {}); maps.push(replacement);
    replacement.update([], null, false); expect(element.querySelector('.leaflet-control-zoom')).not.toBeNull();
  });
});
