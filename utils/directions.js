const cleanPart = (value) => (typeof value === 'string' ? value.trim() : '');

const buildDestinationQuery = (...parts) => {
  const unique = [];
  parts.flat().forEach((part) => {
    const value = cleanPart(part);
    if (value && !unique.some((item) => item.toLowerCase() === value.toLowerCase())) {
      unique.push(value);
    }
  });
  return unique.join(', ');
};

const buildDirectionsUrls = (destination, platform = 'web') => {
  const query = cleanPart(destination);
  if (!query) return null;
  const encoded = encodeURIComponent(query);
  const nativeUrl = platform === 'ios'
    ? `maps://?daddr=${encoded}&dirflg=d`
    : platform === 'android'
      ? `google.navigation:q=${encoded}`
      : null;
  return {
    nativeUrl,
    webUrl: `https://www.google.com/maps/dir/?api=1&destination=${encoded}`,
  };
};

module.exports = {
  buildDestinationQuery,
  buildDirectionsUrls,
};
