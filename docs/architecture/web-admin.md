# Web administration architecture

The admin shell authenticates and authorizes operations users, then lazy-loads Dashboard, Drivers, Tours, Broadcast, Moderation, and Settings routes. The loading state is accessible and feature chunks do not enter the initial route bundle.

Large sections are split into feature presentation and data modules while their historic `src/components/*` entrypoints remain compatible. Dashboard and Tours use bounded views/components; tour CRUD, content mutation, CSV import, assignment, and context are separate data responsibilities. Drivers and broadcasts expose focused feature components/domain helpers.

Presentation must not issue raw Firebase operations. Reads, subscriptions, and mutations go through the existing service/repository boundary, preserving authorization checks, confirmations, Mantine controls, URL filters, and data shapes.

To add an admin section, create a feature folder, expose a stable route component, add a `React.lazy` route in `App.jsx`, provide an accessible loading state, keep Firebase calls in a repository/service, and add visible behavior tests plus a production-build chunk check.
