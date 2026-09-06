# homebridge-coway-airmega

[![npm version](https://img.shields.io/npm/v/homebridge-coway-airmega.svg)](https://www.npmjs.com/package/homebridge-coway-airmega)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Homebridge plugin that brings WiFi-connected **Coway Airmega** air purifiers into
HomeKit — power, fan speed, auto mode, air quality, filter life and the panel light.

Written in TypeScript with **no runtime dependencies**.

## Status

Developed and verified end-to-end against an **Airmega 400S** (`AP-2015E`).

Other IoCare-connected Airmega models (250S, 300S, 400S, IconS) use the same API
and should work, but are untested. Reports welcome — please include your
`modelCode` and `productModel` from the Homebridge log.

## How it works, and what that costs you

Coway Airmega purifiers expose **no local API**. The unit sits on your LAN but
answers nothing — no mDNS advertisement, no open ports, no HTTP service. Every
command and every status read goes through Coway's IoCare cloud.

Two consequences to weigh before installing:

**Control requires internet.** A LAN-only or internet-isolated Homebridge cannot
reach the purifier at all. If your WAN is down, so is this plugin.

**State is scraped, not queried.** Coway publishes no status JSON endpoint — this
was verified by probing both IoCare API hosts across every plausible path, all of
which return 404. The only machine-readable copy of device state is a payload
embedded in the page the IoCare app renders inside a webview. This plugin parses
that payload.

That is genuinely brittle, and it is worth being honest about: a Coway front-end
change can break status reads. The plugin is written to **fail loudly** if that
happens rather than degrade quietly, because a silent empty state would look
exactly like a purifier that had switched itself off. If you see
`No status payload found in the IoCare page` in your log, that is this failing,
and the fix lives in `src/purifierState.ts`.

## HomeKit services

| Service | Characteristics |
|---|---|
| **Air Purifier** | Active, Current/Target Air Purifier State, Rotation Speed, Lock Physical Controls |
| **Air Quality Sensor** | Air Quality, PM10 Density, PM2.5 Density *(only on models that report it)* |
| **Filter Maintenance** ×2 | Filter Life Level and Filter Change Indication, for the pre-filter and the Max2 filter |
| **Lightbulb** | The panel light — optional, disabled by default |

### Mapping notes

Coway's hardware and HomeKit's model do not line up exactly. Where they diverge:

- **Fan speed.** The hardware has three steps, so the HomeKit slider snaps to
  33 / 67 / 100. Dragging to 0 powers the unit off.
- **Modes.** HomeKit's `TargetAirPurifierState` offers only AUTO and MANUAL.
  Coway's *auto* and *eco* both report as AUTO; *night* and *rapid* report as
  MANUAL, since HomeKit has no vocabulary for them.
- **Air quality.** Coway grades 1–4; HomeKit uses 1–5. The mapping skips
  HomeKit's GOOD so Coway's worst grade still reaches POOR.
- **Filter life.** Coway reports consumption, HomeKit wants life remaining, so
  the values are inverted before publishing.

## Installation

Search for **Coway Airmega** in the Homebridge UI plugin browser, or:

```bash
npm install -g homebridge-coway-airmega
```

## Configuration

Configurable through the Homebridge UI, or by hand:

```json
{
  "platforms": [
    {
      "platform": "CowayAirmega",
      "name": "Coway Airmega",
      "username": "you@example.com",
      "password": "your-iocare-password",
      "pollIntervalSeconds": 60,
      "exposeLight": false
    }
  ]
}
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `username` | string | — | IoCare account email. Required. |
| `password` | string | — | IoCare account password. Required. |
| `pollIntervalSeconds` | integer | `60` | How often to read state. Values below 30 are clamped. |
| `exposeLight` | boolean | `false` | Expose the panel light as a HomeKit bulb. |

Purifiers are discovered automatically across every "place" on the account.

## Account requirements and limits

Read this section before opening an issue about login failures.

- **Email/password accounts only.** If your IoCare account signs in with Google
  or Apple, there is no password to send and the plugin cannot authenticate.
  You would need to create an IoCare account with a password.
- **Coway forces a password change every 60 days.** The mobile app lets you
  defer this; a headless login cannot. When it triggers, the plugin raises
  `PasswordExpiredError` — change the password in the IoCare app, then update
  your config.
- **Coway rate-limits logins,** blocking an account for roughly 24 hours after
  repeated failures. The plugin is deliberately conservative here: it holds one
  token pair for its lifetime, prefers refreshing over re-authenticating,
  collapses concurrent callers onto a single login, and **stops permanently**
  after a rate-limit response rather than retrying into a deeper block. If you
  get blocked, wait it out and confirm the IoCare app itself still signs in.
- **Polling costs several cloud requests per device per tick.** The 30-second
  floor exists to protect your rate budget, not to be annoying.

## Troubleshooting

**The accessory does not appear in HomeKit.** Check which bridge it landed on.
If your other plugins run as child bridges, this one goes onto the *main*
Homebridge bridge, which you may not have paired. Either pair the main bridge or
give this platform its own `_bridge` block.

**`No status payload found in the IoCare page`.** Either the session expired
(the plugin will recover on the next poll) or Coway changed the webview format
(it will not). Open an issue.

**Filters immediately show "change filter".** That is usually accurate. Coway
reports filter life directly; if you have already replaced them, reset the
counter in the IoCare app.

**`Coway rejected the username or password`.** See the account section above —
social login and the 60-day password expiry are the two usual causes.

## Development

```bash
npm install
npm test           # unit tests
npm run lint
npm run build
```

`src/purifierState.ts` holds the pure decoding and HomeKit mapping and carries
most of the test coverage. The network layer is kept deliberately thin, so the
logic worth testing does not require mocking HTTP.

## Credit

The IoCare authentication and control protocol was reverse-engineered by
[RobertD502/cowayaio](https://github.com/RobertD502/cowayaio), whose Python
implementation is the reference for the flow used here. This plugin is an
independent TypeScript implementation, not a port or a wrapper, and carries no
runtime dependencies.

Not affiliated with or endorsed by Coway.

## License

[Apache-2.0](LICENSE)
