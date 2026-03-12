# LLT Web Admin Dashboard

Operations dashboard for Loch Lomond Travel built with React + Vite + Mantine.

## What this app does

- Driver CRUD + tour assignments
- Tour monitoring and operational status views
- Broadcast announcements
- Admin settings workflows

## Stack

- React 19
- Vite 7
- Mantine 8
- React Router 7
- Firebase JS SDK 12
- Vitest + Testing Library

## Local setup

```bash
npm install
npm run dev
```

Build + preview:

```bash
npm run build
npm run preview
```

## Tests

```bash
npm test
npm run test:components
npm run test:services
npm run test:utils
npm run test:all
```

## Operational contracts

- Date/timestamp parsing must use strict helpers in `src/utils/dateUtils.js`.
- Driver assignment writes must match `docs/data-contracts/driver-assignment.md`.
- User-facing errors should be sanitized (avoid raw backend/internal messages).
- Follow security header configuration in `vite.config.js` for preview/deploy parity.
