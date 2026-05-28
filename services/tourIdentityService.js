const normalizeTourId = (value) => {
  if (typeof value !== 'string') return null;

  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[.#$\[\]/]/g, '')
    .replace(/^_+|_+$/g, '');

  return normalized || null;
};

const resolveTourId = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizeTourId(candidate);
    if (normalized) return normalized;
  }

  return null;
};

module.exports = {
  normalizeTourId,
  resolveTourId,
};
