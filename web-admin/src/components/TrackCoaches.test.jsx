import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, useLocation } from 'react-router-dom';
const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), renderer: { update: vi.fn(), focus: vi.fn(), fit: vi.fn(), destroy: vi.fn(), retryTiles: vi.fn() }, options: null }));
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('../services/coachTrackingService', () => ({ subscribeCoachTracking: (...args) => mocks.subscribe(...args) }));
vi.mock('../features/coach-tracking/map/createCoachMap', () => ({ createCoachMap: (_element, options) => { mocks.options = options; return mocks.renderer; } }));
import TrackCoaches from './TrackCoaches';
const NOW = Date.now();
const row = (tourId, age = 30_000) => ({ schemaVersion: 1, listed: true, tourId, tourCode: tourId, name: `Tour ${tourId}`,
  assignedDrivers: [{ driverId: 'D1', name: 'Driver One' }], startAtMs: NOW, endAtMs: NOW + 86400000, isActive: true,
  location: { isSharing: true, mode: 'live', source: 'auto', latitude: 56, longitude: -4, timestamp: NOW - age, accuracy: 12 } });
function Location() { return <output data-testid="route">{useLocation().search}</output>; }
const mount = (route = '/track-coaches') => render(<MantineProvider><MemoryRouter initialEntries={[route]}><TrackCoaches /><Location /></MemoryRouter></MantineProvider>);
let handlers;
let unsubscribe;
beforeEach(() => {
  vi.clearAllMocks(); handlers = null; unsubscribe = vi.fn();
  mocks.subscribe.mockImplementation((_database, value) => { handlers = value; return unsubscribe; });
});
const deliver = async (rows, other = {}) => act(async () => {
  handlers.onStatus({ schemaVersion: 1, state: 'ready' }); handlers.onConnection(true); handlers.onClock(0);
  handlers.onRows({ rows, complete: true, capped: false, ...other });
});

describe('Track Coaches operational workspace', () => {
  it('shows real positions, selects details from map/list, searches and preserves URL state', async () => {
    mount(); expect(screen.getByText('Connecting to the tracking feed…')).toBeInTheDocument();
    await deliver({ A: row('A'), B: row('B', 900000) });
    expect(screen.getByText('Connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View A, Tour A' }));
    expect(screen.getByRole('region', { name: 'Details for A' })).toBeInTheDocument();
    expect(mocks.renderer.focus).toHaveBeenCalledWith('A');
    fireEvent.click(screen.getByRole('button', { name: 'Focus selected tour' }));
    expect(mocks.renderer.focus).toHaveBeenLastCalledWith('A');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find a tour or driver' }), { target: { value: 'Tour B' } });
    expect(screen.queryByRole('button', { name: 'View A, Tour A' })).not.toBeInTheDocument();
    expect(screen.getByTestId('route')).toHaveTextContent('q=Tour+B');
    expect(screen.queryByRole('region', { name: 'Details for A' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'View A, Tour A' })).toBeInTheDocument();
    await act(async () => mocks.options.onSelect('B'));
    expect(screen.getByRole('region', { name: 'Details for B' })).toBeInTheDocument();
  });
  it('labels demo data prominently, never subscribes to real GPS, and can return to real mode', async () => {
    mount('/track-coaches?demo=1');
    expect(screen.getByText('Demonstration mode · sample locations')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View DEMO-01/ })).toBeInTheDocument();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Return to live tracking' }));
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: /View DEMO-01/ })).not.toBeInTheDocument();
  });
  it('provides a list-only view, fixed pickup controls and truthful tile failure fallback', async () => {
    mount('/track-coaches?demo=1&view=list');
    expect(screen.queryByRole('region', { name: 'Coach location map' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Map', { exact: true }));
    expect(screen.getByRole('region', { name: 'Coach location map' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show fixed pickup pins' }));
    expect(mocks.renderer.update.mock.lastCall[2]).toBe(true);
    await act(async () => mocks.options.onTileStatus('error'));
    expect(screen.getByText('Map tiles are unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry map tiles' }));
    expect(mocks.renderer.retryTiles).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /View DEMO-01/ })).toBeInTheDocument();
  });
  it('marks cached positions offline and removes deleted sources from map and selected details', async () => {
    mount(); await deliver({ A: row('A') });
    fireEvent.click(screen.getByRole('button', { name: 'View A, Tour A' }));
    await act(async () => handlers.onConnection(false));
    expect(screen.getByText('Connection lost · cached positions')).toBeInTheDocument();
    expect(mocks.renderer.update.mock.lastCall[0][0].state).toBe('recent');
    await deliver({});
    expect(screen.queryByRole('region', { name: 'Details for A' })).not.toBeInTheDocument();
    expect(mocks.renderer.update.mock.lastCall[0]).toEqual([]);
  });
  it('shows partial coverage, clears rows after a feed error and ignores late snapshots until Retry', async () => {
    mount(); await deliver({ A: row('A') }, { complete: false, capped: true, limit: 10000 });
    expect(screen.getByText('Fleet coverage is incomplete')).toBeInTheDocument();
    await act(async () => handlers.onError('Access denied'));
    expect(screen.getByText('Tracking feed unavailable')).toBeInTheDocument();
    await act(async () => handlers.onRows({ rows: { A: row('A') }, complete: true }));
    expect(screen.queryByRole('button', { name: 'View A, Tour A' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry tracking feed' }));
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('tears down data and renderer ownership on unmount', async () => {
    const rendered = mount(); await deliver({ A: row('A') }); rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(mocks.renderer.destroy).toHaveBeenCalledOnce();
  });
});
