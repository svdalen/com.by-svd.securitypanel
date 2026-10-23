# Security Panel for Homey Pro

A standalone alarm system for Homey Pro that uses your existing Homey sensors
(door/window contacts, motion sensors, vibration and tamper sensors) as
detectors, with exit and entry delays, PIN users, a dashboard keypad widget,
and optional two-way mirroring with other alarm panels such as a Ring Alarm
basestation.

It uses Homey's built-in `homealarm` device class and `homealarm_state`
capability (`disarmed`, `armed`, `partially_armed`), so flows, dashboards and
bridges see a normal Homey alarm device.

## Features

- **Panel device** (class `homealarm`): mode, alarm status and a live countdown.
- **Delays**: exit delay when arming, entry delay per sensor, alarm duration.
- **Pre-arm check**: open sensors block arming (or only warn, or are ignored).
- **Sensors are used automatically**: every contact, motion, vibration,
  tamper, occupancy and presence sensor on Homey takes part, including ones
  added later. Contact-type sensors count in both modes, motion-type sensors
  only in Armed (configurable). Per-sensor overrides change modes and entry
  delay, or exclude a sensor; "Reset all to defaults" drops the overrides.
- **Include / exclude sensors**: bypass a sensor temporarily (a window you
  leave open) from the settings page, from flows, or via `PUT /sensors/enabled`.
  An excluded sensor neither blocks arming nor triggers; its settings are kept.
- **Panic code**: a configurable digit (or two) typed after the normal PIN
  disarms exactly like a normal PIN, shows nothing on screen, and fires the
  silent trigger "A panic code was entered" with the user name.
- **Two alarm stages** as flow triggers and conditions: "The alarm is pending"
  (sensor tripped, entry delay running) and "The alarm is sounding" (after the
  delay). Both can be posted to the Homey timeline, as can mode changes.
- **Sirens**: any on/off device, switched on when the alarm sounds and off
  when it ends, is silenced or disarmed.
- **LED indicator lights**: colour lights or strips follow the state. Defaults:
  armed red, partially armed orange, countdown yellow, alarm red, disarmed
  green and off after 20 s. Colours, off-delays and brightness are settings.
- **PIN users**: 4 to 8 digits, scrypt-hashed, per-user arm/disarm rights,
  per-keypad lockout after 5 wrong attempts (30 s, doubling).
- **Keypad widget** for Homey Dashboards, a fixed-size panel with views per
  state: while disarmed it lists the sensors with their mode and open/closed
  state and offers Arm and Home; those open the keypad in place (an idle
  keypad closes after 30 s); during the exit delay it shows a checklist of
  the sensors in the pending mode with the countdown and a Cancel button;
  while armed it shows only a bordered "Intrusion will be reported" panel, on
  purpose without sensor names; an entry countdown or alarm opens the keypad
  automatically. Codes are verified in the app, never in the browser. Taps
  register on the press, so fast repeated taps are never lost or zoomed.
  Optional beeps from the tablet itself for the alarm, the entry delay and the
  exit delay (needs one touch on the screen after the dashboard loaded, a
  browser rule). The sensor list can be turned off per widget.
- **Sensor status widget**: a second dashboard widget that lists sensors with
  their zone, Open / Closed / Motion / Clear state and how long ago they were
  last tripped, filterable by zone. Those times come from Homey's own
  capability timestamps, so they survive an app restart.
- **Sensor timeline widget**: a scrolling log of recent sensor changes and,
  optionally, arm / disarm / alarm markers, filterable by zone and time
  window. Like the status widget it hides itself while armed by default. The
  log lives in memory (up to 200 events) and starts empty after an app
  restart; it never contains user names. By default it hides itself while the
  system is armed, so a wall tablet never advertises which doors are open to
  someone who should not know; the setting carries that warning.
- **Exit delay semantics**: arming always starts the exit delay, even with a
  door open. The open-sensor policy (block / warn / ignore) is applied when the
  delay ends. By default only door/window type sensors count at that moment,
  because motion sensors stay "active" for a while after you walk past them;
  this is a toggle in the settings.
- **Device tile and flow protection**: the panel's device tile and Homey's
  built-in "Set state" card cannot ask for a PIN, and a tap on an alarm tile
  on a dashboard can send a state change by itself. By default the tile is
  therefore read-only (a tap only opens the device); it can be allowed to arm,
  or to arm and disarm. A second option stops the
  PIN-less flow cards from disarming ("Set the mode with a PIN" still works).
  For a shared tablet, log the Homey app in as a Homey Guest user: guests can
  control devices and start flows but cannot change settings, flows or users.
  With the read-only tile and flow protection on, the keypad widget is the
  only way to disarm from that tablet, and the tablet stays free for other apps.
- **Linked panels**: mirror mode with any other `homealarm_state` device
  (Ring basestation). Arming from the Ring keypad arms this panel immediately,
  arming here arms Ring.
- **Flow cards**: 11 triggers, 4 conditions, 5 actions (see below).
- **App API** for other apps and physical keypads:
  `GET /status`, `POST /keypad {pin, action}`, `PUT /mode`, `POST /alarm/deactivate`.

## Requirements

- Homey Pro (2019 or 2023) on firmware 12.3.0 or newer. Widgets and the
  `homey:manager:api` permission do not exist on Homey Cloud.
- Node.js 18+ and the Homey CLI on your development machine.

## Install for development

```bash
npm install
```

```bash
npx homey login
```

```bash
npx homey app run
```

`homey app run` installs the app on your Homey and streams its log. Use
`npx homey app install` for a persistent install without the log stream.

## Set up

1. Add the **Security Panel** device (Devices, add, Security Panel).
2. Open the app settings:
   - set exit delay, entry delay, alarm duration and the open-sensor policy;
   - tick which sensors belong to Armed and Partially armed, and which ones
     get the entry delay (the doors you walk in through);
   - optionally tick linked panels (e.g. Ring basestation);
   - add keypad users with a PIN.
3. Add the **Alarm keypad** widget to a dashboard. Widget settings let you hide
   the Home button, hide open sensors, require a PIN for arming, and
   auto-submit after 4 or 6 digits.
4. Build flows for what happens on alarm (sirens, lights, notifications) using
   the **The alarm was triggered** trigger, and for countdown feedback using
   **Countdown tick**.

## Ring Keypad

The Ring Keypad (gen 1 and gen 2) pairs **directly with this app** over Z-Wave,
no Ring Security app, no Heimdall, no flows. Add a device, choose *Security
Panel, Ring Keypad*, and follow the pairing wizard: hold the 1 key for three
seconds, then enter the 5-digit S2 PIN Homey asks for. That PIN is the first
five digits of the DSK printed next to the QR code on the sticker on the back
of the keypad (and on the card in the box). Do not enter 00000: that pairs
without encryption and the keypad's codes will not reach Homey. If the keypad
is currently paired to another app or hub, remove or factory-reset it first.

Once paired everything is automatic:

- Code + Disarm / Home / Away / Enter buttons are checked against the panel's
  users (panic digit included); the keypad shows a green check or red cross.
- The keypad's lights follow the panel: Disarmed, Home, Away.
- The exit and entry delay drive the keypad's light bar and countdown sound.
  The keypad has no delays of its own: it announces exactly what the panel
  sends. Device settings choose which countdowns are announced (Away exit,
  Home exit, entry); the app settings hold the durations, with a separate
  exit delay for Home that is 0 by default. After an app restart or update the
  keypad is only updated when the mode actually changed, so it stays quiet.
- When the alarm sounds the keypad sounds its siren (burglar, smoke, medical,
  or lights only, per device setting) and stops when the alarm ends.
- Emergency buttons: Police sounds the alarm (device setting) and all three
  fire the device trigger *An emergency button was held* and the panic trigger.
- Device settings expose the keypad's volumes, brightness, display timeouts
  and proximity detection (turn that off if the keypad freezes after a code).
- Device flow cards: *A code was entered* (accepted, user, action; the code is
  never exposed), *Play a chime*, *Siren*.

Other keypads (frient, or a Ring Keypad kept on the Ring Security app) can use
the flow card *Handle a physical keypad entry* with their code and key tags.

The official **Ring** app (com.amazon.ring) exposes the keypad only as a
battery and tamper sensor and cannot be used as a keypad.

## Security model

- Anything that weakens the alarm needs a user code: disarming, silencing,
  cancelling an entry countdown, excluding a sensor, and re-arming while an
  alarm sounds or is pending. This holds for the widget, physical keypads and
  the app API alike. Arming may be code-free (app setting).
- Flows can disarm, silence or bypass without a code only while the setting
  "Flows may disarm, silence or bypass without a code" is on. Cards that take
  a code always work.
- User management happens only through the settings page (owner/manager),
  never through the app API. Codes are scrypt-hashed and verified
  asynchronously; wrong attempts lock out per keypad and globally.
- The panic code can never collide with another user's code; the app refuses
  such codes when they are created.



```
disarmed ──arm──▶ arming (exit delay) ──▶ armed ──sensor──▶ entry (entry delay) ──▶ alarm
    ▲                 │                     │  └── instant sensor ───────────────────▶ alarm
    └──── disarm ─────┴─────────────────────┴──────────── disarm ─────────────────────┘
```

- Sensors tripping during the exit delay are ignored (you are leaving).
- Only sensors assigned to the current mode can trigger.
- `alarm` ends by disarm, by the Silence button or flow card (stays armed), or
  after the alarm duration (stays armed).
- After an app restart the mode is restored. An interrupted entry delay becomes
  an alarm and an interrupted exit delay becomes armed: failing safe means
  staying armed.
- Mode changes from flows and the device tile need no PIN (whoever can reach
  those already has Homey access). The widget and `POST /keypad` always need a
  PIN for disarming.

## Flow cards

App cards (under the app in the flow editor):

- Triggers: Armed (away), Partially armed (home), Disarmed, The mode changed,
  Exit delay started (arming), Arming was blocked by open sensors, Armed while
  sensors were open, Countdown tick, Countdown cancelled, The alarm was
  triggered (entry delay running, not sounding yet), The alarm started
  sounding, The alarm stopped sounding, A valid PIN was entered, An invalid PIN
  was entered, A panic code was entered, A sensor was excluded or included.
- Conditions: The mode is, The alarm is sounding, The alarm is triggered (entry
  delay running), A countdown is running, Sensors are open, A sensor is excluded.
- Actions: Set the mode, Set the mode with a PIN, Silence the alarm (stay
  armed), Sound the alarm now, Cancel the running countdown, Exclude a sensor,
  Include a sensor.

Panel device cards (pick the Security Panel device in the flow editor):

- Triggers: Armed (away), Partially armed (home), Disarmed, Exit delay started,
  Alarm triggered (entry delay running, not sounding yet), Alarm sounding,
  Alarm stopped sounding, plus Homey's built-in "The state changed".
- Conditions: Is armed / partially armed / disarmed, Alarm is sounding, Alarm
  is triggered.
- Actions: Arm, Partially arm, Disarm, Silence the alarm, plus Homey's
  built-in "Set state".

The device shows two purpose-named sensors, "Alarm sounding" and "Alarm
triggered (entry delay)", both with Insights.

## Project layout

```
app.js                      wiring: engine <-> devices, flows, widget, settings
api.js                      app API (settings page, other apps)
lib/AlarmEngine.js          pure state machine (no Homey dependency, unit tested)
lib/PinStore.js             hashed PIN users + lockout (unit tested)
lib/SensorMonitor.js        Web API subscriptions to sensors and linked panels, device bridge
lib/Indicators.js           sirens and LED lights driven by the alarm state (unit tested)
drivers/panel/              the homealarm device
widgets/keypad/             keypad dashboard widget (api.js + public/index.html)
widgets/sensors/            sensor status dashboard widget
widgets/timeline/           sensor timeline dashboard widget
settings/index.html         app settings page
.homeycompose/              manifest, flow cards, custom capability
test/                       node:test unit tests
```

## Develop

Every dev release bumps the patch version and installs on the selected Homey:

```bash
npm run push
```

Regenerate the widget preview images from the real widget (needs Edge or
Chrome installed):

```bash
npm run previews
```

```bash
npm test
```

```bash
npx homey app validate --level publish
```

`app.json` is generated from `.homeycompose/` by the CLI. Edit the compose
files, not `app.json`.

## Known limitations

- The app store images in `assets/images` are solid-colour placeholders.
  Replace them before publishing. The widget previews are real renders.
- English only for now. Translations go in `locales/` and the `{ "en": ... }`
  objects in `.homeycompose/`.
- The Ring keypad's own PIN list is managed by Ring, not by this app. The app
  trusts mode changes coming from a linked panel.
- The dashboard tablet runs as a Homey user. Do not also place the raw panel
  device tile on a dashboard that strangers can reach, since the tile changes
  the mode without a PIN. Use a dedicated Homey user with limited rights for
  wall tablets.
