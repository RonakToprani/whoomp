# whoomp — Build Guide

> **Always read the exact versioned Expo docs before touching native config:**
> https://docs.expo.dev/versions/v56.0.0/

---

## What This App Is

Expo SDK 56 / React Native / TypeScript iOS app. Connects to a WHOOP 4.0 over BLE,
reads live biometrics (HR, RR, SpO2), computes HRV / recovery / strain / sleep
entirely on-device, and shows a dashboard. No backend. No cloud. No WHOOP subscription.

**Bundle ID:** `com.ronakto.whoomp`

---

## Current Repo State

| File | Status |
|---|---|
| `app.json` | ✅ Done — BLE plugin, bundle ID, background-central mode, permission strings |
| `eas.json` | ✅ Done — development + preview EAS build profiles |
| `src/ble/constants.ts` | ✅ Done — corrected UUIDs (see section below) |
| Everything else | ⬜ Not written yet |

---

## THE STRATEGY: Copy from whoof, don't reinvent

`madhursatija/whoof` (`ios-app` branch) is a fully working WHOOP 4.0 BLE client
written in clean, modular JavaScript. It runs live at **https://getwhoof.pages.dev**.

The BLE protocol, packet framing, CRC-32, all data parsers, and every metrics
algorithm are already implemented and battle-tested. The entire job is:

1. **Copy 5 files verbatim** (just add TypeScript types — zero logic changes)
2. **Write one adapter file** that maps Web Bluetooth API → `react-native-ble-plx`
3. **Write one React hook** wrapping the client
4. **Wire two screens** (scan + live HR)

That's Phase 1. Get HR on screen. Everything else builds on top.

### Fetch any whoof file directly

```bash
gh api "repos/madhursatija/whoof/contents/web/js/ble/FILENAME?ref=ios-app" \
  --jq '.content' | base64 -d

gh api "repos/madhursatija/whoof/contents/web/js/metrics/FILENAME?ref=ios-app" \
  --jq '.content' | base64 -d
```

---

## CRITICAL: UUID Correction

The README originally listed `61080000` as the service UUID. **This is wrong.**
Two independent working implementations both confirm:

```
SERVICE (scan filter):   61080001-8d6d-82b8-614a-1c8cb0f8dcc6
CMD_TO_STRAP   (Write):  61080002-8d6d-82b8-614a-1c8cb0f8dcc6
CMD_FROM_STRAP (Notify): 61080003-8d6d-82b8-614a-1c8cb0f8dcc6
EVENTS         (Notify): 61080004-8d6d-82b8-614a-1c8cb0f8dcc6
DATA           (Notify): 61080005-8d6d-82b8-614a-1c8cb0f8dcc6
DIAGNOSTICS    (Notify): 61080007-8d6d-82b8-614a-1c8cb0f8dcc6
```

Sources confirming these:
- `madhursatija/whoof` → `web/js/ble/uuids.js` (ios-app branch)
- `cs-balazs/gowhoop`  → `internal/gowhoop/consts.go`

`src/ble/constants.ts` already has the corrected values. **Do not revert them.**

---

## Packet Framing (not what the README said)

The README described a simplified frame. The real format confirmed by whoof:

```
[0xAA] [len_lo] [len_hi] [crc8(len_bytes)] [type] [seq] [cmd] [data...] [crc32_le × 4 bytes]
```

- `len` (uint16 LE) = body_length + 4, where body = `[type, seq, cmd, data...]`
- There is a **CRC-8 on the 2-byte length field** AND a **CRC-32 on the body**
- Use `WhoopPacket.fromData()` from `protocol.ts` to parse every incoming notification
- Use `buildCommandFrame(cmd, payload)` from `protocol.ts` for every outgoing write

The CRC-32 is **not** standard Ethernet. Final XOR is `0xFFFFFFFF` (not the `0xF43F44AC`
in the README). Use whoof's `crc32Whoop()` implementation exactly.

---

## Phase 1 Implementation — Connect + Live HR

**Goal:** scan → connect → see BPM on screen. Proof the BLE pipeline works.
Run on a **real iPhone** (no simulator BLE).

### File map

```
src/
  ble/
    constants.ts     ✅ already done
    crc32.ts         ← copy from whoof  web/js/ble/crc.js
    protocol.ts      ← copy from whoof  web/js/ble/packet.js
    parser.ts        ← copy from whoof  web/js/ble/parsers.js
    WhoopClient.ts   ← adapt from whoof web/js/ble/client.js  (only non-trivial file)
    useBLE.ts        ← new (thin React hook)
  screens/
    ScanScreen.tsx   ← new (one button)
    LiveScreen.tsx   ← new (big HR number)
  App.tsx            ← replace generated file
```

### Step 1 of 7 — crc32.ts

Fetch `web/js/ble/crc.js`. Pure math, no imports, no Web APIs. Add types only:

```typescript
const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1
    t[i] = crc >>> 0
  }
  return t
})()

// CRC8_TABLE = [ ... ] — 256-entry lookup table, copy verbatim from whoof

export function crc32Whoop(data: Uint8Array): number { ... }
export function crc8(data: Uint8Array): number { ... }
export function verifyCrc(data: Uint8Array, expected: number): boolean { ... }
```

No logic changes. Just annotate parameter and return types.

### Step 2 of 7 — protocol.ts

Fetch `web/js/ble/packet.js`. Pure logic, no Web APIs.

- Keep all enums (`PacketType`, `CommandNumber`, `EventNumber`, `MetadataType`) verbatim
- Keep `WhoopPacket` class verbatim
- Keep `buildCommandFrame()` verbatim
- Fix import: `import { crc32Whoop as crc32, crc8 } from './crc32'`
- Add TypeScript types to method signatures

Key enum values you'll use immediately:
```typescript
PacketType.REALTIME_DATA    = 40   // live HR stream
PacketType.HISTORICAL_DATA  = 47   // flash drain
PacketType.METADATA         = 49   // history START/END/COMPLETE
PacketType.EVENT            = 48   // wrist-on/off, charging, etc.
PacketType.COMMAND_RESPONSE = 36   // strap echoes our commands back

CommandNumber.TOGGLE_REALTIME_HR    = 3    // payload [0x01] = on, [0x00] = off
CommandNumber.GET_HELLO_HARVARD     = 35   // payload [0x00] → serial + status
CommandNumber.SET_CLOCK             = 10   // payload = u32 LE unix seconds
CommandNumber.GET_CLOCK             = 11
CommandNumber.SEND_HISTORICAL_DATA  = 22
CommandNumber.HISTORICAL_DATA_RESULT = 23  // ack trim
CommandNumber.GET_BATTERY_LEVEL     = 26
```

### Step 3 of 7 — parser.ts

Fetch `web/js/ble/parsers.js`. Pure logic.

- Fix import: `import { PacketType, MetadataType, EventNumber, EventName } from './protocol'`
- Add TypeScript return types

`decodePacket(pkt: WhoopPacket)` is the top-level dispatcher. Call this on every
incoming notification. It returns a tagged union:

```typescript
// type: 'realtime'
{ type: 'realtime', heartRateBpm: number|null, rrIntervalsMs: number[], receivedAt: number }

// type: 'historical'
{ type: 'historical', unix: number, heartRateBpm: number|null, rrIntervalsMs: number[], flashIndex: number }

// type: 'metadata'
{ type: 'metadata', kind: 'historyStart'|'historyEnd'|'historyComplete', trim?: number }

// type: 'event'
{ type: 'event', cmd: number, name: string, semantic?: string }

// type: 'response'
{ type: 'response', cmd: number, data: Uint8Array }
```

### Step 4 of 7 — WhoopClient.ts (the one non-trivial file)

This replaces Web Bluetooth with `react-native-ble-plx`. The connection sequence,
historical drain state machine, and event routing are **identical to whoof's client.js**.
Only the transport calls change.

#### Install dependencies first

```bash
# These are not installed yet:
npm install @react-navigation/native @react-navigation/stack
npx expo install react-native-screens react-native-safe-area-context
# expo-sqlite for Phase 2 (install now, don't use yet):
npx expo install expo-sqlite
```

#### Base64 ↔ Uint8Array helpers (add to WhoopClient.ts)

react-native-ble-plx passes all characteristic values as base64 strings.

```typescript
function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
```

`btoa` / `atob` are globally available in React Native's Hermes runtime. Do NOT
use Node.js `Buffer` — it's not available in RN without a polyfill.

#### Web Bluetooth → react-native-ble-plx mapping

```typescript
import { BleManager, Device, Subscription } from 'react-native-ble-plx'
const manager = new BleManager()  // one instance for the app lifetime

// ── SCAN ──────────────────────────────────────────────────────────────────
// Web BT: navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }] })
manager.startDeviceScan([SERVICES.WHOOP], null, (error, device) => {
  if (error) { /* handle */ return }
  if (device?.name?.startsWith('WHOOP')) {
    manager.stopDeviceScan()
    connect(device)
  }
})
// manager.stopDeviceScan() to cancel

// ── CONNECT ───────────────────────────────────────────────────────────────
// Web BT: device.gatt.connect() → server.getPrimaryService() → service.getCharacteristic()
const connected: Device = await device.connect()
await connected.discoverAllServicesAndCharacteristics()
// After this, all services/chars are cached on the device object

// ── SUBSCRIBE (notify) ────────────────────────────────────────────────────
// Web BT: char.startNotifications() + char.addEventListener('characteristicvaluechanged')
const sub: Subscription = connected.monitorCharacteristicForService(
  SERVICES.WHOOP,
  CHARACTERISTICS.DATA,
  (error, char) => {
    if (error || !char?.value) return
    const bytes = b64ToBytes(char.value)
    const pkt = WhoopPacket.fromData(bytes)
    handlePacket(decodePacket(pkt))
  }
)
// sub.remove() to unsubscribe

// ── WRITE ─────────────────────────────────────────────────────────────────
// Web BT: char.writeValueWithResponse(bytes)
await connected.writeCharacteristicWithResponseForService(
  SERVICES.WHOOP,
  CHARACTERISTICS.CMD_TO_STRAP,
  bytesToB64(buildCommandFrame(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01])))
)

// ── DISCONNECT LISTENER ───────────────────────────────────────────────────
// Web BT: device.addEventListener('gattserverdisconnected', handler)
connected.onDisconnected((error, d) => {
  // mirror whoof's _onDisconnected(): exponential backoff reconnect
  scheduleReconnect()
})
```

#### Connection sequence (mirror whoof client.js exactly)

```
1. scan for SERVICE UUID → stopDeviceScan on first WHOOP hit
2. device.connect() → discoverAllServicesAndCharacteristics()
3. subscribe to CMD_FROM_STRAP (type 36 responses)
4. subscribe to DATA          (type 40 realtime + type 47 historical + type 49 metadata)
5. subscribe to EVENTS        (type 48 events)
6. sendCommand(GET_HELLO_HARVARD, [0x00])  → learn serial / charging / wrist-worn
7. getClock() → if |strap_unix - Date.now()/1000| > 5: setClock(Date.now()/1000)
8. downloadHistory()   → drain flash buffer (see state machine)
9. sendCommand(TOGGLE_REALTIME_HR, [0x01]) → start live HR stream
```

#### Historical drain state machine (from whoof client.js `downloadHistory()`)

```typescript
async downloadHistory() {
  await this.sendCommand(CommandNumber.SEND_HISTORICAL_DATA, new Uint8Array([0x00]))
  // HISTORICAL_DATA packets (type 47) now flow on the DATA char.
  // They are routed to this.emit('historicalSample', decoded) in the data handler.
  // METADATA packets (type 49) are queued for this loop:
  while (true) {
    const meta = await this._metaQueue.pop(30_000)  // AsyncQueue, same as whoof
    if (meta.kind === 'historyComplete') break
    if (meta.kind === 'historyEnd') {
      // ack: [0x01][trim u32 LE][0x00 × 4]
      const ack = new Uint8Array(9)
      ack[0] = 0x01
      ack[1] = meta.trim & 0xff
      ack[2] = (meta.trim >>> 8) & 0xff
      ack[3] = (meta.trim >>> 16) & 0xff
      ack[4] = (meta.trim >>> 24) & 0xff
      await this.sendCommand(CommandNumber.HISTORICAL_DATA_RESULT, ack)
    }
  }
}
```

Copy `AsyncQueue` verbatim from whoof client.js (it's a tiny 20-line class at the top).

#### Events emitted by WhoopClient

Use a minimal inline emitter (no npm package):

```typescript
class Emitter {
  private _h: Record<string, Array<(p: any) => void>> = {}
  on<T>(event: string, fn: (p: T) => void): () => void {
    ;(this._h[event] ??= []).push(fn)
    return () => { this._h[event] = this._h[event].filter(h => h !== fn) }
  }
  emit(event: string, payload?: any) { this._h[event]?.forEach(fn => fn(payload)) }
}
```

Events:
```
'state'            → 'disconnected' | 'connecting' | 'connected'
'realtime'         → { heartRateBpm: number|null, rrIntervalsMs: number[], receivedAt: number }
'historicalSample' → { unix: number, heartRateBpm: number|null, rrIntervalsMs: number[] }
'historyComplete'  → { samples: number }
'event'            → decoded event object from parser.ts
'battery'          → number (0–100)
'error'            → Error
```

### Step 5 of 7 — useBLE.ts

```typescript
import { useState, useEffect, useRef } from 'react'
import { WhoopClient } from './WhoopClient'

export function useBLE() {
  const clientRef = useRef<WhoopClient | null>(null)
  const [state, setState] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected')
  const [heartRate, setHeartRate] = useState<number | null>(null)
  const [rr, setRr] = useState<number[]>([])
  const [battery, setBattery] = useState<number | null>(null)

  useEffect(() => {
    const client = new WhoopClient()
    clientRef.current = client
    const off = [
      client.on('state', setState),
      client.on<{ heartRateBpm: number | null; rrIntervalsMs: number[] }>(
        'realtime',
        ({ heartRateBpm, rrIntervalsMs }) => {
          setHeartRate(heartRateBpm)
          setRr(prev => [...prev.slice(-300), ...rrIntervalsMs]) // keep ~5-min window
        }
      ),
      client.on('battery', setBattery),
    ]
    return () => { off.forEach(fn => fn()); client.destroy() }
  }, [])

  return {
    state,
    heartRate,
    rr,
    battery,
    scan:       () => clientRef.current?.scan(),
    disconnect: () => clientRef.current?.disconnect(),
  }
}
```

### Step 6 of 7 — Screens

**ScanScreen.tsx** — minimal:
- Show "Whoomp" title
- Button: "Connect to WHOOP"
- Warning label: "Close the official WHOOP app first"
- Spinner while `state === 'connecting'`
- Navigate to LiveScreen when `state === 'connected'`

**LiveScreen.tsx** — minimal:
- Large BPM number (gray when null, white when live)
- Battery % in corner
- "Disconnect" button
- (RR array is available in hook but don't render yet — Phase 2 adds HRV)

### Step 7 of 7 — App.tsx

```typescript
import { NavigationContainer } from '@react-navigation/native'
import { createStackNavigator } from '@react-navigation/stack'
import ScanScreen from './screens/ScanScreen'
import LiveScreen from './screens/LiveScreen'

const Stack = createStackNavigator()

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Scan" screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Scan" component={ScanScreen} />
        <Stack.Screen name="Live" component={LiveScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
```

---

## Running on Device

1. Build the dev client (first time only — required for native BLE module):
```bash
eas build --profile development --platform ios
# Install the resulting .ipa on your iPhone via TestFlight internal or direct install
```

2. Start the Expo dev server:
```bash
npx expo start --dev-client
```

3. Open the whoomp dev client on iPhone → scan QR code

The simulator has no BLE hardware. Always test on a real device.

---

## Phase 2: Metrics + Storage

Only start after Phase 1 works on a real device.

### Metrics — all copy-paste from whoof

Fetch and add TypeScript types. Zero logic changes.

| Fetch path | Save as | Key exports |
|---|---|---|
| `web/js/metrics/hrv.js` | `src/metrics/hrv.ts` | `rmssd()`, `sdnn()`, `pnn50()`, `filterRr()` |
| `web/js/metrics/recovery.js` | `src/metrics/recovery.ts` | `recoveryScore()`, `recoveryBreakdown()` |
| `web/js/metrics/strain.js` | `src/metrics/strain.ts` | `strainScore()`, `acwr()` |
| `web/js/metrics/sleep.js` | `src/metrics/sleep.ts` | `detectSleepWindow()`, `classifyStages()` |
| `web/js/metrics/zones.js` | `src/metrics/zones.ts` | `zoneForHr()`, `zoneSecondsFromHrSeries()` |

All five files are pure math — no imports outside the metrics folder, no Web APIs.

**HRV from the `rr` array in useBLE:**
```typescript
import { rmssd, filterRr } from '../metrics/hrv'
// rrWindow = last 300 RR intervals (~5 min at 1 Hz)
const hrv = rmssd(filterRr(rr))  // number | null
```

**Recovery needs 14 days of history** → requires SQLite (below).

### Storage — expo-sqlite

Two tables only:

```sql
-- One row per incoming realtime/historical sample
CREATE TABLE IF NOT EXISTS samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unix        INTEGER NOT NULL,
  hr          INTEGER,
  rr_json     TEXT,        -- JSON.stringify(rrIntervalsMs)
  flash_index INTEGER,
  source      TEXT         -- 'realtime' | 'historical'
);

-- One row per calendar day, rolled up on app open
CREATE TABLE IF NOT EXISTS daily (
  date          TEXT PRIMARY KEY,  -- 'YYYY-MM-DD'
  rmssd         REAL,
  rhr           REAL,
  strain        REAL,
  sleep_minutes INTEGER,
  recovery      REAL
);
```

`expo-sqlite` is already in package.json. Use it with the new async API:
```typescript
import * as SQLite from 'expo-sqlite'
const db = await SQLite.openDatabaseAsync('whoomp.db')
```

---

## Phase 3: Dashboard UI

Reference: **https://getwhoof.pages.dev** — live whoof web app, open on desktop
Chrome to see the full dashboard layout and colour scheme.

**New screens:**
- `HomeScreen` — Recovery ring (0-100, green/yellow/red) + today's summary cards
- `TrendsScreen` — 14-day line charts for HRV, resting HR, strain
- `SleepScreen` — Sleep stages timeline bar
- `SettingsScreen` — Age (for max HR), wrist side (left/right), disconnect

**New components:**
- `RecoveryRing` — circular SVG progress indicator
- `MetricCard` — number + label + 7-day trend
- `HRChart` — 5-min live HR sparkline

**Charting:** use `victory-native` (install: `npm install victory-native react-native-svg`).
Avoid heavy charting libraries — a simple `<Polyline>` on `react-native-svg` is enough
for Phase 1 sparklines.

---

## Gotchas Checklist

### Must close WHOOP app before scanning
The strap allows only **one BLE central connection** at a time. If the official WHOOP
app holds the connection, the strap will not appear in scans. Add a visible warning on
`ScanScreen`.

### CRC on every write
If a write to `CMD_TO_STRAP` has a bad CRC the strap **silently ignores** it.
Always use `buildCommandFrame()` from `protocol.ts`. Never hand-craft raw bytes.

### Strap reconnect
The strap will drop BLE after ~30 s with no traffic. In practice, subscribed
notifications keep it alive. On `onDisconnected`, wait 1 s then reconnect with
exponential backoff (cap at 30 s) — copy whoof client.js `_onDisconnected()`.

### BleManager singleton
Create exactly **one** `BleManager` instance at the top of `WhoopClient.ts` (module
level or in the constructor). Creating multiple instances causes state conflicts.

### iOS permissions at runtime
`react-native-ble-plx` will call the system Bluetooth permission dialog automatically
on first scan. The permission strings in `app.json` must be set (they are). No extra
code needed.

### Background BLE
`UIBackgroundModes: ["bluetooth-central"]` is already in `app.json`. With the dev
client built via EAS, the app will keep receiving realtime packets when screen-locked.

### npx tsc --noEmit
Run this after every file you add. The project is TypeScript-strict. Fix type errors
before moving on.

---

## Dependencies Already Installed

```json
"expo": "~56.0.0",
"expo-dev-client": "~56.0.19",
"react-native-ble-plx": "^3.5.1",
"expo-sqlite": "already in package.json"
```

## Dependencies to Install Before Starting Phase 1

```bash
npm install @react-navigation/native @react-navigation/stack
npx expo install react-native-screens react-native-safe-area-context
```

---

## Reference Repos

| Repo | Branch | How to use |
|---|---|---|
| `madhursatija/whoof` | `ios-app` | **Primary.** Copy `web/js/ble/` + `web/js/metrics/` verbatim |
| `cs-balazs/gowhoop` | `main` | Cross-check UUIDs + packet byte offsets |
| `b-nnett/goose` | `main` | WHOOP **5.0** only — different protocol, skip |

**whoof live app:** https://getwhoof.pages.dev (use Chrome desktop to see the full dashboard)
