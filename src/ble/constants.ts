// WHOOP 4.0 confirmed GATT UUIDs.
// Verified by two independent working implementations:
//   - madhursatija/whoof (web/js/ble/uuids.js, ios-app branch)
//   - cs-balazs/gowhoop  (internal/gowhoop/consts.go)
//
// NOTE: The README listed 61080000 as the service UUID — that is WRONG.
// The real advertised service UUID is 61080001. The strap scans will not
// find the device if you filter on 61080000.

export const SERVICES = {
  WHOOP: '61080001-8d6d-82b8-614a-1c8cb0f8dcc6',
  HEART_RATE: '0000180d-0000-1000-8000-00805f9b34fb',
  DEVICE_INFO: '0000180a-0000-1000-8000-00805f9b34fb',
  BATTERY: '0000180f-0000-1000-8000-00805f9b34fb',
} as const;

export const CHARACTERISTICS = {
  CMD_TO_STRAP:   '61080002-8d6d-82b8-614a-1c8cb0f8dcc6', // Write
  CMD_FROM_STRAP: '61080003-8d6d-82b8-614a-1c8cb0f8dcc6', // Notify
  EVENTS:         '61080004-8d6d-82b8-614a-1c8cb0f8dcc6', // Notify
  DATA:           '61080005-8d6d-82b8-614a-1c8cb0f8dcc6', // Notify
  DIAGNOSTICS:    '61080007-8d6d-82b8-614a-1c8cb0f8dcc6', // Notify
  HR_MEASUREMENT: '00002a37-0000-1000-8000-00805f9b34fb', // Notify (standard HR profile)
} as const;

export type ServiceUUID = (typeof SERVICES)[keyof typeof SERVICES];
export type CharacteristicUUID = (typeof CHARACTERISTICS)[keyof typeof CHARACTERISTICS];
