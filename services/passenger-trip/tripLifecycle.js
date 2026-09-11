const { sameScope } = require('./tripBoundary');
const { getTripCache } = require('./tripCache');
const owners = new Set();
const registerTripController = (controller) => {
  owners.add(controller);
  return () => { controller.stop(); owners.delete(controller); };
};
const stopPassengerTrip = (scope) => {
  for (const controller of owners) if (sameScope(controller.scope, scope)) controller.stop();
};
const purgePassengerTrip = async (scope) => {
  stopPassengerTrip(scope);
  await getTripCache().purge(scope);
};
module.exports = { registerTripController, stopPassengerTrip, purgePassengerTrip };
