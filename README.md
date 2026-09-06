# homebridge-coway-airmega

Homebridge plugin for WiFi-connected Coway Airmega air purifiers.

Verified against an **Airmega 400S** (`AP-2015E`).

## How it talks to the purifier

Coway Airmega units expose **no local API**. The device sits on your LAN but
answers nothing — no mDNS, no open ports, no HTTP. All control goes through
Coway's IoCare cloud, so this plugin needs your IoCare account.

Two consequences worth knowing before you install:

- **Control requires internet.** A LAN-only Homebridge cannot reach the purifier.
- **State is scraped, not queried.** Coway publishes no status JSON endpoint
  (verified by probing both API hosts). The only machine-readable copy of device
  state is a payload embedded in the page the IoCare app renders in a webview.
  This plugin parses that payload. It works, but a Coway front-end change can
  break it, and it will fail loudly rather than silently reporting a purifier as off.

## HomeKit services

| Service | Characteristics |
|---|---|
| Air Purifier | Active, Current/Target state, Rotation Speed, Lock Physical Controls |
| Air Quality Sensor | Air Quality, PM10 (PM2.5 only if the model reports it) |
| Filter Maintenance ×2 | Filter Life Level and Change Indication for the pre-filter and Max2 filter |
| Lightbulb | Panel light — optional, off by default |

Coway's three fan steps map onto HomeKit's slider at 33 / 67 / 100. Coway's
`eco` mode reports as HomeKit AUTO, since HomeKit models only auto vs manual.

## Configuration

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

## Account requirements and limits

- **Email/password IoCare accounts only.** A Google or Apple social login has no
  password to send, and the plugin cannot authenticate with one.
- **Coway forces a password change every 60 days.** The app can defer this; a
  headless login cannot. When it happens the plugin raises a clear error — change
  the password in the IoCare app and update the config.
- **Coway rate-limits logins,** blocking an account for roughly 24 hours after
  repeated failures. The plugin holds one token pair for its lifetime, refreshes
  rather than re-logging in, and stops permanently after a rate-limit response
  instead of retrying into a deeper block.
- Polling below 30 seconds is clamped, since each poll costs several requests.

## Development

```
npm install
npm test        # unit tests
npm run lint
npm run build
```

`src/purifierState.ts` holds the pure decoding and HomeKit mapping and carries
most of the test coverage; the network layer is thin by design.

## Credit

The IoCare authentication and control protocol was worked out by
[RobertD502/cowayaio](https://github.com/RobertD502/cowayaio). This plugin is an
independent TypeScript implementation of the same flow, with no runtime dependencies.
