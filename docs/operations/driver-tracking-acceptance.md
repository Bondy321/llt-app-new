# Driver tracking device acceptance

Code tests exercise session races, real RTDB rules and authenticated HTTP writes.
They do not prove execution while locked on iOS/Android. Run these checks on a
physical iPhone and Android phone using a native `1.0.7` build, after deploying
the tracking rules, stop endpoint and projection/cleanup Functions.

The rules change updates the notification-retention protocol artifact digest.
Existing retention evidence cannot authorize the new protocol; refresh its
deployment attestation through the existing retention procedure after deployment.

Android uses a user-started foreground location service with a visible persistent
notification. It does not request `ACCESS_BACKGROUND_LOCATION`. iOS requires
Always access and shows the system background location indicator. Only drivers
who confirm the disclosure receive tracking permission prompts.

| Action | Required result |
| --- | --- |
| Passenger login, fresh install, restore saved driver preferences | No tracking prompt and no automatic tracking start |
| Start, cancel disclosure or reject permissions | No native tracking and no live point for this session |
| Driver confirms Start and grants access | Explicit session active; fresh GPS acknowledged; Android notification/iOS indicator visible |
| Navigate to manifest/chat; move with app visible | Session stays active, fresh point follows the phone; fixed pickup stays separate |
| Move for ten minutes with phone locked; switch apps | Supported background delivery continues; public updates carry actual server time. Record cadence and gaps per device/OS |
| Disconnect, move, reconnect | Paused status when detectable; no replay of old positions; next valid fresh fix can publish |
| Stop while a fix is pending | Native tracking stops; stopped fence blocks late writes; exact live point withdrawn; another phone and pickup survive |
| Stop offline, reopen, retry | No automatic restart; cleanup identity retained and acknowledged on reconnection |
| Change tour, sign out, remove location access/services | Former session cannot publish; no silent restart for another driver/tour |
| Force-close/force-stop; launch again | OS delivery may stop. Reopening retires interrupted intent and requires explicit new Start |
| Reboot, battery saver, manufacturer battery restrictions | Record observed OS limits; app reports missing/stale updates truthfully on return |
| Account deletion or login as a different driver | Native task stopped; old local tracking identity purged; new driver starts only explicitly |

Use synthetic driver/tour data. Capture device model, OS/build version, observed
timestamps and pass/fail. Background scheduling is OS-controlled; force-stop,
termination and battery restrictions do not have a guaranteed automatic recovery.
Do not mark Stage 4 accepted until the physical-device results are recorded.
