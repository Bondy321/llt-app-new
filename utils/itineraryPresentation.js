const TIME_12H_PATTERN = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([aApP])\.?\s?([mM])\.?\b/;
const TIME_24H_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const BULLET_PATTERN = /[\u2022\u2023\u25E6\u2043\u2219]/g;
const LIST_PREFIX_PATTERN = /^(?:[-*]|\d{1,2}[.)]|[a-zA-Z][.)])\s+/;
const TRAILING_PUNCTUATION_PATTERN = /[\s,;]+$/;

const KEYWORD_ICONS = [
  { iconKey: 'bus-clock', terms: ['pickup', 'pick up', 'depart', 'departure', 'leave', 'coach', 'bus', 'transfer'] },
  { iconKey: 'airplane', terms: ['airport', 'flight', 'fly'] },
  { iconKey: 'train', terms: ['train', 'station', 'rail'] },
  { iconKey: 'ferry', terms: ['ferry', 'boat', 'cruise', 'sail'] },
  { iconKey: 'bed-outline', terms: ['hotel', 'check in', 'check-in', 'accommodation', 'overnight'] },
  { iconKey: 'silverware-fork-knife', terms: ['breakfast', 'lunch', 'dinner', 'meal', 'restaurant', 'supper'] },
  { iconKey: 'coffee-outline', terms: ['coffee', 'tea', 'refreshment', 'free time', 'leisure'] },
  { iconKey: 'camera-outline', terms: ['photo', 'viewpoint', 'view point', 'scenic', 'panorama'] },
  { iconKey: 'walk', terms: ['walk', 'walking', 'hike', 'trail', 'stroll'] },
  { iconKey: 'castle', terms: ['castle', 'palace', 'ruin'] },
  { iconKey: 'bank-outline', terms: ['museum', 'gallery', 'visitor centre', 'visitor center'] },
  { iconKey: 'map-marker-path', terms: ['visit', 'tour', 'explore', 'excursion', 'stop'] },
  { iconKey: 'shopping-outline', terms: ['shop', 'shopping', 'market'] },
  { iconKey: 'calendar-check-outline', terms: ['arrive', 'arrival', 'return'] },
];

const normalizeWhitespace = (value) => String(value || '')
  .replace(/\r\n?/g, '\n')
  .replace(/\t/g, ' ')
  .replace(/\u00A0/g, ' ')
  .replace(/[ ]{2,}/g, ' ')
  .trim();

const cleanSegment = (value) => normalizeWhitespace(value)
  .replace(LIST_PREFIX_PATTERN, '')
  .replace(TRAILING_PUNCTUATION_PATTERN, '')
  .trim();

const countWords = (value) => cleanSegment(value).split(/\s+/).filter(Boolean).length;

const hasTimeToken = (value) => {
  const text = String(value || '');
  return TIME_12H_PATTERN.test(text) || TIME_24H_PATTERN.test(text);
};

const looksLikeAgendaFragment = (value) => {
  const cleaned = cleanSegment(value).toLowerCase();
  if (!cleaned) return false;
  if (hasTimeToken(cleaned)) return true;
  return KEYWORD_ICONS.some(({ terms }) => terms.some((term) => cleaned.includes(term)));
};

const splitSemicolonList = (line) => {
  const parts = line.split(/\s*;\s*/).map(cleanSegment).filter(Boolean);
  if (parts.length <= 1) return [line];

  const timedPartCount = parts.filter(hasTimeToken).length;
  const shouldSplit = parts.length >= 3
    || timedPartCount >= 2
    || (timedPartCount >= 1 && parts.every((part) => countWords(part) <= 14))
    || parts.every(looksLikeAgendaFragment);

  return shouldSplit ? parts : [line];
};

const splitInlineListSeparators = (line) => {
  const normalized = line
    .replace(/\s+\|\s+/g, '\n')
    .replace(/\s+\/\s+/g, '\n')
    .replace(/\s+-\s+(?=(?:[01]?\d|2[0-3]):[0-5]\d\b)/g, '\n')
    .replace(/\s+(?=\d{1,2}[.)]\s+)/g, '\n');

  return normalized
    .split('\n')
    .flatMap(splitSemicolonList)
    .map(cleanSegment)
    .filter(Boolean);
};

const splitItineraryContent = (content) => {
  const normalized = normalizeWhitespace(content);
  if (!normalized) return [];

  return normalized
    .replace(BULLET_PATTERN, '\n')
    .split('\n')
    .flatMap(splitInlineListSeparators)
    .map(cleanSegment)
    .filter(Boolean);
};

const hashString = (value) => {
  let hash = 5381;
  const input = String(value || '');
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
};

const slugify = (value) => {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);

  return slug || 'item';
};

const getItineraryIconKey = (text) => {
  const normalized = String(text || '').toLowerCase();
  const match = KEYWORD_ICONS.find(({ terms }) => terms.some((term) => normalized.includes(term)));
  return match?.iconKey || 'map-marker-outline';
};

const buildItineraryItems = (content) => splitItineraryContent(content).map((segment, index) => {
  const text = cleanSegment(segment);

  return {
    id: `agenda-${index + 1}-${slugify(text)}-${hashString(segment)}`,
    text,
    rawText: segment,
    iconKey: getItineraryIconKey(segment),
  };
});

module.exports = {
  buildItineraryItems,
  getItineraryIconKey,
  splitItineraryContent,
};
