# Refactor performance verification

## Functions import surface

| Signal | Baseline | Final |
| --- | ---: | ---: |
| `functions/index.js` | 259,848 bytes / 6,899 lines | 66 bytes / 4 lines |
| Direct imports | 21 | 1 (`./src/compositionRoot`) |
| `sharp` loaded by index import | Yes (eager index dependency) | No |
| `expo-server-sdk` loaded by index import | Yes (eager index dependency) | No |
| Clean-process local require time | Not captured in the original baseline | See `functions-import-final.json` |

The final clean-process probe recorded local import time, loaded module count, and the ten largest domain modules. This is a regression signal, not a Cloud Functions cold-start benchmark; machine cache, Node version, and local environment materially affect it.

## Mobile structure

| Entry | Baseline | Final |
| --- | ---: | ---: |
| `App.js` | 92,430 bytes / 2,218 lines | 60 bytes / 4 lines |
| `screens/ChatScreen.js` | 213,264 bytes / 6,330 lines | 61 bytes / 2 lines |
| `services/chatService.js` | 73,972 bytes / 2,100 lines | 1,325 bytes / 56 lines |
| `services/bookingServiceRealtime.js` | 78,378 bytes / 2,036 lines | 971 bytes / 40 lines |
| `services/photoService.js` | 48,512 bytes / 1,364 lines | 1,015 bytes / 41 lines |

Production cycles remain zero. Screen/component Firebase SDK imports are zero, and the final presentation audit removed the remaining direct screen persistence import. Expo iOS and Android exports are part of final validation.

## Web administration

Dashboard and Tours were split behind their existing lazy route boundaries. Production build chunk sizes are recorded in the final engineering report after the clean build. Chunk results are compared with the baseline values in `refactor-baseline.md`; build output is not committed.
