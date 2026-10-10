const LEGACY_ITINERARY_PLACEHOLDER = 'itinerary coming soon!';
const SOURCE_STATUSES = new Set(['ready', 'missing_source', 'operator_preserved']);

const cleanText = (value) => (typeof value === 'string' ? value.trim() : '');
const isLegacyPlaceholder = (value) => cleanText(value).toLowerCase() === LEGACY_ITINERARY_PLACEHOLDER;

export const hasSubstantiveCustomerItinerary = (itinerary) => {
  const days = Array.isArray(itinerary?.days) ? itinerary.days : [];
  return days.some((day) => {
    if (cleanText(day?.content) && !isLegacyPlaceholder(day.content)) return true;
    if (cleanText(day?.description) && !isLegacyPlaceholder(day.description)) return true;
    return (Array.isArray(day?.activities) ? day.activities : []).some((activity) => (
      cleanText(activity?.description) && !isLegacyPlaceholder(activity.description)
    ));
  });
};

export const hasLegacyPlaceholderOnlyItinerary = (itinerary) => {
  const days = Array.isArray(itinerary?.days) ? itinerary.days : [];
  if (!days.length || hasSubstantiveCustomerItinerary(itinerary)) return false;
  return days.some((day) => (
    isLegacyPlaceholder(day?.content)
    || isLegacyPlaceholder(day?.description)
    || (Array.isArray(day?.activities) && day.activities.some((activity) => isLegacyPlaceholder(activity?.description)))
  ));
};

const formatReportDate = (reportDate) => (
  typeof reportDate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(reportDate)
    ? reportDate
    : ''
);

export const getTourItineraryReadiness = (tour = {}) => {
  const source = tour?.itinerarySource;
  const sourceStatus = source?.schemaVersion === 1 && SOURCE_STATUSES.has(source?.status)
    ? source.status
    : null;
  const reportDate = formatReportDate(source?.reportDate);
  const hasDetails = hasSubstantiveCustomerItinerary(tour?.itinerary);

  if (sourceStatus === 'ready') {
    return hasDetails
      ? { state: 'source_available', color: 'green', label: 'Itinerary source available', detail: `Detailed source text was available${reportDate ? ` in the ${reportDate} report` : ''}.` }
      : { state: 'source_incomplete', color: 'orange', label: 'Source available, details missing', detail: 'The importer reports detailed source text, but no substantive customer itinerary is currently stored.' };
  }
  if (sourceStatus === 'missing_source') {
    return hasDetails
      ? { state: 'details_present_source_missing', color: 'yellow', label: 'Details present · source missing', detail: `The current itinerary has content, but the latest source report${reportDate ? ` (${reportDate})` : ''} did not include detailed itinerary text.` }
      : { state: 'missing_source', color: 'red', label: 'Detailed itinerary missing', detail: `No detailed itinerary text was available in the latest source report${reportDate ? ` (${reportDate})` : ''}.` };
  }
  if (sourceStatus === 'operator_preserved') {
    return hasDetails
      ? { state: 'operator_preserved', color: 'blue', label: 'Operator itinerary preserved', detail: `Existing operator itinerary content was preserved${reportDate ? ` during the ${reportDate} source update` : ''}.` }
      : { state: 'preserved_details_missing', color: 'orange', label: 'Preserved itinerary missing', detail: 'The importer reports operator-owned content, but no substantive customer itinerary is currently stored.' };
  }
  if (hasDetails) {
    return { state: 'details_unverified', color: 'gray', label: 'Itinerary available · source unverified', detail: 'A substantive itinerary is stored, but there is no recognized source-availability record.' };
  }
  if (hasLegacyPlaceholderOnlyItinerary(tour?.itinerary)) {
    return { state: 'legacy_placeholder', color: 'orange', label: 'Placeholder only', detail: 'The stored customer itinerary contains only the exact legacy placeholder; source availability is not recorded.' };
  }
  return { state: 'unverified', color: 'gray', label: 'Itinerary readiness unverified', detail: 'No source-availability record or substantive customer itinerary is stored.' };
};
