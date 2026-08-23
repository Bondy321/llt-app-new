const MAX_ROUTE_HISTORY = 20;

const normalizeRoute = (route, fallbackScreen = null, fallbackParams = {}) => {
  const screen = typeof route?.screen === 'string' && route.screen.trim()
    ? route.screen.trim()
    : fallbackScreen;
  if (!screen) return null;
  return {
    screen,
    params: route?.params && typeof route.params === 'object' && !Array.isArray(route.params)
      ? route.params
      : fallbackParams,
  };
};

const createAppRouteHistory = ({ maxEntries = MAX_ROUTE_HISTORY } = {}) => {
  const entries = [];
  const limit = Math.max(1, Number(maxEntries) || MAX_ROUTE_HISTORY);

  return {
    push(route) {
      const normalized = normalizeRoute(route);
      if (!normalized || normalized.screen === 'Login') return false;
      const latest = entries.at(-1);
      if (latest?.screen === normalized.screen && latest?.params === normalized.params) return false;
      entries.push(normalized);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      return true;
    },
    pop({ fallbackScreen, fallbackParams = {} } = {}) {
      return entries.pop() || normalizeRoute(null, fallbackScreen, fallbackParams);
    },
    reset() {
      entries.length = 0;
    },
    size() {
      return entries.length;
    },
  };
};

module.exports = {
  MAX_ROUTE_HISTORY,
  createAppRouteHistory,
};
