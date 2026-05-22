const clampPagerIndex = (index, photoCount) => {
  const count = Number(photoCount);
  if (!Number.isFinite(count) || count <= 0) return 0;

  const numericIndex = Number(index);
  if (!Number.isFinite(numericIndex)) return 0;

  const maxIndex = Math.max(0, Math.floor(count) - 1);
  return Math.min(Math.max(Math.round(numericIndex), 0), maxIndex);
};

const resolvePagerIndexFromOffset = ({ offsetX, pageWidth, photoCount }) => {
  const width = Number(pageWidth);
  if (!Number.isFinite(width) || width <= 0) {
    return clampPagerIndex(0, photoCount);
  }

  return clampPagerIndex(Number(offsetX) / width, photoCount);
};

module.exports = {
  clampPagerIndex,
  resolvePagerIndexFromOffset,
};
