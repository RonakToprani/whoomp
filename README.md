# whoomp
reverse engineering whoop 4.O 

# whoomp — WHOOP 4.0 BLE Client (React Native / Expo)

## What This Is
Local-only iOS app that connects to a WHOOP 4.0 fitness strap over Bluetooth LE, reads raw biometric data, computes HRV/recovery/strain/sleep on-device, and displays everything in a clean dashboard. No backend, no cloud, no WHOOP subscription required.

## Stack
- Expo (SDK 52+) with TypeScript
- react-native-ble-plx (BLE communication, Expo config plugin)
- expo-dev-client (custom dev client for native BLE module)
- expo-sqlite (local persistence)
- EAS Build for iOS device deployment
- Bundle ID: com.ronakto.whoomp

## WHOOP 4.0 BLE Protocol Reference

### GATT Services
| Service | UUID |
|---------|------|
| Custom WHOOP Service | `61080000-8d6d-82b8-614a-1c8cb0f8dcc6` |
| Heart Rate Service (standard) | `0000180d-0000-1000-8000-00805f9b34fb` |
| Device Information Service | `0000180a-0000-1000-8000-00805f9b34fb` |
| Battery Service | `0000180f-0000-1000-8000-00805f9b34fb` |

### Custom Service Characteristics (under 61080000-...)
| Name | UUID | Direction | Properties |
|------|------|-----------|------------|
| CMD_TO_STRAP | `61080001-8d6d-82b8-614a-1c8cb0f8dcc6` | Phone → Strap | Write |
| CMD_FROM_STRAP | `61080002-8d6d-82b8-614a-1c8cb0f8dcc6` | Strap → Phone | Notify |
| EVENTS | `61080003-8d6d-82b8-614a-1c8cb0f8dcc6` | Strap → Phone | Notify |
| DATA_FROM_STRAP | `61080004-8d6d-82b8-614a-1c8cb0f8dcc6` | Strap → Phone | Notify |
| DIAGNOSTICS | `61080005-8d6d-82b8-614a-1c8cb0f8dcc6` | Strap → Phone | Notify |

### Standard Heart Rate Characteristic
UUID: `00002a37-0000-1000-8000-00805f9b34fb` (Notify). Only active after sending "enable HR broadcast" command to CMD_TO_STRAP.

### Command Frame Format
```
[0xAA] [CMD_ID] [LENGTH_LO] [LENGTH_HI] [PAYLOAD...] [CRC32_LE (4 bytes)]
```

### CRC-32 Parameters
- Polynomial: 0x04C11DB7
- Initial: 0xFFFFFFFF
- Input reflection: yes
- Output reflection: yes
- Final XOR: 0xF43F44AC

### Known Command Byte Sequences (from community RE)
```
Enable HR Broadcast:  aa0800a823080e016c935474
Disable HR Broadcast: aa0800a823070e00c7e40f08
```

### 96-Byte Realtime Packet (DATA_FROM_STRAP)
| Bytes | Field | Type | Status |
|-------|-------|------|--------|
| 0 | Packet header | uint8 | Decoded |
| 1–2 | Heart Rate (BPM) | uint16 LE | Confirmed |
| 3–4 | RR Interval (ms) | uint16 LE | Confirmed |
| 5 | SpO2 (%) | uint8 | Confirmed |
| 6 | Skin Temperature (°C) | uint8 scaled | Confirmed |
| 7–12 | Accelerometer X/Y/Z | int16 LE × 3 | Candidate |
| 13 | Motion intensity | uint8 | Candidate |
| 14–15 | PPG amplitude | uint16 LE | Candidate |
| 16–17 | Ambient light | uint16 LE | Candidate |
| 18–19 | PPG signal quality | uint16 LE | Candidate |
| 20–91 | Unknown | — | Undecoded |
| 92–95 | CRC-32 | uint32 LE | CRC of bytes 0–91 |

### Derived Metrics (computed client-side, NOT from strap)
- **HRV (RMSSD)**: √(mean of squared successive RR differences), 5-min rolling window
- **Recovery**: log-transformed RMSSD normalized 0–100 (ref: openwhoop-algos)
- **Strain**: TRIMP-based HR zone accumulator (ref: whoof strain.js)
- **Sleep stages**: stillness classifier + HR/HRV thresholds (ref: openwhoop)
- **HR Zones**: standard 5-zone model based on max HR

## Project Structure
```
whoomp/
├── CLAUDE.md
├── app.json
├── eas.json
├── src/
│   ├── App.tsx
│   ├── ble/
│   │   ├── constants.ts        # All UUIDs
│   │   ├── crc32.ts            # WHOOP CRC-32
│   │   ├── protocol.ts         # buildCommand(), parseFrame()
│   │   ├── parser.ts           # 96-byte packet parser
│   │   ├── WhoopClient.ts      # Scan, connect, subscribe, command
│   │   └── useBLE.ts           # React hook
│   ├── metrics/
│   │   ├── hrv.ts
│   │   ├── strain.ts
│   │   ├── recovery.ts
│   │   ├── sleep.ts
│   │   └── zones.ts
│   ├── data/
│   │   ├── db.ts
│   │   ├── schema.ts
│   │   └── queries.ts
│   ├── screens/
│   │   ├── ScanScreen.tsx
│   │   ├── HomeScreen.tsx
│   │   ├── LiveScreen.tsx
│   │   ├── SleepScreen.tsx
│   │   ├── TrendsScreen.tsx
│   │   └── SettingsScreen.tsx
│   └── components/
│       ├── MetricCard.tsx
│       ├── HRChart.tsx
│       ├── RecoveryRing.tsx
│       └── ConnectionBadge.tsx
```

## Community Reference Repos
- **whoof** (madhursatija/whoof) — best JS BLE implementation, full protocol in docs/PROTOCOL.md
- **whoomp** (jogolden/whoomp) — original RE, whoop.js has command implementations
- **openwhoop** (bWanShiTong) — Rust CLI, type-47 biometric decode, sleep classifier, HRV/strain algos
- **whoop-reader** (christianmeurer) — clean Python parser, 96-byte packet decode
- **my-whoop** (johnmiddleton12) — whoop_protocol.json schema, iOS app reference

## Implementation Phases
- Phase 1: Connect + live HR display (BLE pipeline proof)
- Phase 2: Full sensor parsing + derived metrics + historical drain + local storage
- Phase 3: Polished UI, trends, sleep screen, daily-driver quality

## Important Notes
- The WHOOP 4.0 only allows ONE BLE central connection at a time. Must unpair/close official WHOOP app first.
- Every command written to CMD_TO_STRAP must include a valid CRC-32 or the strap silently ignores it.
- The strap records 1 Hz HR + RR to internal flash continuously. Historical drain pulls this buffer.
- iOS background BLE requires UIBackgroundModes: bluetooth-central in Info.plist (handled by plugin config).
