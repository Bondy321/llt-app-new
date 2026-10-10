import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { Badge, MantineProvider, Text, Tooltip } from '@mantine/core';
import { TourItineraryReadiness } from './TourItineraryReadiness';
import {
  getTourItineraryReadiness,
  hasLegacyPlaceholderOnlyItinerary,
  hasSubstantiveCustomerItinerary,
} from './tourItineraryReadinessModel';

describe('tour itinerary readiness', () => {
  it('recognizes the exact legacy placeholder without treating a real itinerary as placeholder-only', () => {
    const placeholder = { title: 'Tour name', days: [{ day: 1, content: 'Itinerary coming soon!' }] };
    expect(hasLegacyPlaceholderOnlyItinerary(placeholder)).toBe(true);
    expect(hasSubstantiveCustomerItinerary(placeholder)).toBe(false);
    expect(getTourItineraryReadiness({ itinerary: placeholder }).state).toBe('legacy_placeholder');

    const detailed = { days: [{ day: 1, content: 'Itinerary coming soon!', activities: [{ description: 'Visit the museum' }] }] };
    expect(hasLegacyPlaceholderOnlyItinerary(detailed)).toBe(false);
    expect(hasSubstantiveCustomerItinerary(detailed)).toBe(true);
  });

  it('distinguishes missing source from operator-preserved content using only importer metadata', () => {
    const missing = getTourItineraryReadiness({
      itinerarySource: { schemaVersion: 1, status: 'missing_source', reportDate: '2026-10-10' },
    });
    expect(missing.state).toBe('missing_source');
    expect(missing.detail).toContain('2026-10-10');

    const preserved = getTourItineraryReadiness({
      itinerarySource: { schemaVersion: 1, status: 'operator_preserved', reportDate: '2026-10-10' },
      itinerary: { days: [{ day: 1, activities: [{ description: 'Operator stop' }] }] },
    });
    expect(preserved.state).toBe('operator_preserved');
    expect(preserved.detail).toContain('preserved');
  });

  it('does not claim source availability when metadata is absent or malformed', () => {
    const readiness = getTourItineraryReadiness({
      itinerarySource: { schemaVersion: 9, status: 'ready' },
      itinerary: { days: [{ day: 1, activities: [{ description: 'Known stop' }] }] },
    });
    expect(readiness.state).toBe('details_unverified');
    expect(readiness.label).toContain('source unverified');
  });

  it('reports inconsistent ready metadata when the customer itinerary is empty', () => {
    const readiness = getTourItineraryReadiness({
      itinerarySource: { schemaVersion: 1, status: 'ready', reportDate: '2026-10-10' },
      itinerary: { days: [{ day: 1, activities: [] }] },
    });
    expect(readiness.state).toBe('source_incomplete');
    expect(readiness.detail).toContain('no substantive customer itinerary');
  });

  it('renders an admin readiness badge for the exact legacy placeholder', () => {
    expect(TourItineraryReadiness).toBeTypeOf('function');
    expect(Badge).toBeDefined();
    expect(Text).toBeDefined();
    expect(Tooltip).toBeDefined();
    expect(MantineProvider).toBeDefined();
    render(createElement(
      MantineProvider,
      null,
      createElement(TourItineraryReadiness, {
        tour: { itinerary: { days: [{ day: 1, content: 'Itinerary coming soon!' }] } },
      }),
    ));
    expect(screen.getByText('Placeholder only')).toBeInTheDocument();
  });
});
