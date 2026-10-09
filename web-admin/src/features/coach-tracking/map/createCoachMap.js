import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export const COACH_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
const DEFAULT_CENTER = [56.25, -4.25];
const coordinate = point => [point.latitude, point.longitude];

// The renderer owns one map instance, never the subscription or selection.
// Text from tours/drivers is inserted as textContent, never provider HTML.
export function createCoachMap(element, { onSelect, onTileStatus, tileUrl = COACH_TILE_URL } = {}) {
  const map = L.map(element, { center: DEFAULT_CENTER, zoom: 6, scrollWheelZoom: false,
    zoomControl: true, attributionControl: true, preferCanvas: true });
  const tiles = L.tileLayer(tileUrl, { attribution, maxZoom: 19, crossOrigin: false,
    updateWhenIdle: true, keepBuffer: 1 }).addTo(map);
  const layers = L.layerGroup().addTo(map);
  const scale = L.control.scale({ imperial: false }).addTo(map);
  let rows = [];
  let selected = null;
  let showPickups = false;
  let initialFit = false;
  let destroyed = false;
  let tileErrors = 0;
  let viewMode = 'fit';
  let changingView = false;
  tiles.on('loading', () => { tileErrors = 0; });
  tiles.on('tileerror', () => { tileErrors += 1; onTileStatus?.('error'); });
  tiles.on('load', () => onTileStatus?.(tileErrors ? 'error' : 'ready'));

  const icon = (label, kind, chosen = false) => {
    const node = document.createElement('span');
    node.className = `coach-map-pin coach-map-pin--${kind}${chosen ? ' coach-map-pin--selected' : ''}`;
    node.textContent = label;
    return L.divIcon({ html: node, className: 'coach-map-marker', iconSize: [38, 38], iconAnchor: [19, 19] });
  };
  const marker = (point, label, kind, chosen, title) => L.marker(coordinate(point), {
    icon: icon(label, kind, chosen), title, alt: title, keyboard: true,
    zIndexOffset: chosen ? 1000 : 0,
  }).addTo(layers);
  const available = () => rows.flatMap(row => [row.position, ...(showPickups ? [row.pickup] : [])]).filter(Boolean);
  const fit = () => {
    viewMode = 'fit';
    changingView = true;
    const points = available();
    if (!points.length) { map.setView(DEFAULT_CENTER, 6, { animate: false }); changingView = false; return; }
    const bounds = L.latLngBounds(points.map(coordinate));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12, animate: false });
    changingView = false;
  };
  const draw = () => {
    if (destroyed) return;
    layers.clearLayers();
    const buckets = new Map();
    rows.filter(row => row.position).forEach(row => {
      const pixel = map.latLngToLayerPoint(coordinate(row.position));
      // Stable screen-sized groups keep overlapping coaches discoverable.
      const key = `${Math.floor(pixel.x / 50)}:${Math.floor(pixel.y / 50)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    });
    buckets.forEach(group => {
      const focused = group.find(row => row.tourId === selected);
      const row = focused || group[0];
      if (group.length === 1) {
        const title = `${row.tourCode}: ${row.meta.label}. ${row.name}`;
        const pin = marker(row.position, '●', row.state, Boolean(focused), title);
        const tooltip = document.createElement('span'); tooltip.textContent = row.tourCode;
        pin.bindTooltip(tooltip, { direction: 'top' });
        pin.on('click', () => onSelect?.(row.tourId));
      }
      if (group.length > 1) {
        const centre = { latitude: group.reduce((sum, item) => sum + item.position.latitude, 0) / group.length,
          longitude: group.reduce((sum, item) => sum + item.position.longitude, 0) / group.length };
        const pin = marker(centre, String(group.length), 'cluster', Boolean(focused), `${group.length} tour positions nearby. Choose a tour.`);
        const list = document.createElement('div'); list.className = 'coach-map-cluster-list';
        const heading = document.createElement('strong'); heading.textContent = `${group.length} tour positions`; list.append(heading);
        group.forEach(item => {
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = `${item.tourCode} · ${item.meta.label}`;
          button.addEventListener('click', () => { map.closePopup(); onSelect?.(item.tourId); }); list.append(button);
        });
        pin.bindPopup(list, { maxHeight: 240, maxWidth: 280 });
      }
    });
    if (showPickups) rows.filter(row => row.pickup).forEach(row => {
      const pin = marker(row.pickup, 'P', 'pickup', false, `${row.tourCode}: fixed pickup point, not a live coach position`);
      const label = document.createElement('span'); label.textContent = `${row.tourCode} · Fixed pickup: ${row.pickup.address}`;
      pin.bindTooltip(label); pin.on('click', () => onSelect?.(row.tourId));
    });
  };
  map.on('zoomend moveend', draw);
  map.on('dragstart zoomstart', () => { if (!changingView) viewMode = 'manual'; });
  const resize = new ResizeObserver(() => {
    if (destroyed) return;
    map.invalidateSize({ pan: true, animate: false });
    if (initialFit && viewMode === 'fit') fit();
  });
  resize.observe(element);
  return {
    update(nextRows, selectedTour, pickups) {
      rows = nextRows; selected = selectedTour; showPickups = pickups;
      if (!initialFit && available().length) { initialFit = true; fit(); }
      draw();
    },
    focus(tourId) {
      const row = rows.find(item => item.tourId === tourId);
      const point = row?.position || (showPickups ? row?.pickup : null);
      if (point) {
        viewMode = 'selected'; changingView = true;
        map.setView(coordinate(point), Math.max(map.getZoom(), 11), { animate: false });
        changingView = false;
      }
    },
    fit,
    retryTiles: () => tiles.redraw(),
    destroy() { destroyed = true; resize.disconnect(); layers.clearLayers(); scale.remove(); map.remove(); },
  };
}
