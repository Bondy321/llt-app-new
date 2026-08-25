export const normalizeAssignmentTourIdInput = (value) => {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[.#$[\]/]/g, '')
    .replace(/^_+|_+$/g, '');
};

export const resolveAssignmentTourIdInput = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizeAssignmentTourIdInput(candidate);
    if (normalized) return normalized;
  }
  return '';
};
