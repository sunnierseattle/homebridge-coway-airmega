import { describe, expect, it } from 'vitest';

import {
  extractStatusPayload,
  parsePurifierState,
  toAirQuality,
  toRotationSpeed,
  fromRotationSpeed,
  isLightOn,
  lightCommand,
  detectLightConvention,
} from './purifierState.js';

describe('extractStatusPayload', () => {
  const wrap = (obj: unknown) =>
    `<html><script>self.x=1</script><script>${JSON.stringify(obj)}</script></html>`;

  const page = {
    children: [
      'some-string-child',
      {
        coreData: [{ data: { sensorInfo: { attributes: { '0002': 12, '0011': 40 } } } }],
        deviceStatusData: { data: { statusInfo: { attributes: { '0001': 1, '0002': 2 } } } },
        deviceModule: {
          data: { content: { deviceModuleDetailInfo: { wifiConnected: true, airStatusInfo: { iaqGrade: 2 } } } },
        },
      },
    ],
  };

  it('pulls status, sensor and network blocks out of the webview page', () => {
    const out = extractStatusPayload(wrap(page));
    expect(out.status).toEqual({ '0001': 1, '0002': 2 });
    expect(out.sensor).toEqual({ '0002': 12, '0011': 40 });
    expect(out.network.wifiConnected).toBe(true);
    expect(out.iaqGrade).toBe(2);
  });

  it('ignores script tags that do not carry the sensor payload', () => {
    const noisy = `<script>window.a={}</script>${wrap(page)}`;
    expect(extractStatusPayload(noisy).status).toEqual({ '0001': 1, '0002': 2 });
  });

  it('throws a typed error when the page has no payload, rather than returning junk', () => {
    expect(() => extractStatusPayload('<html><body>logged out</body></html>')).toThrow(/payload/i);
  });
});

describe('parsePurifierState', () => {
  const base = {
    status: { '0001': 1, '0002': 2, '0003': 0, '0007': 0, '0024': 1 },
    sensor: { '0002': 25, '0007': 48, '0011': 100, '0012': 100 },
    network: { wifiConnected: true },
    iaqGrade: 1,
  };

  it('decodes power, mode flags and lock', () => {
    const s = parsePurifierState(base);
    expect(s.isOn).toBe(true);
    expect(s.nightMode).toBe(true);
    expect(s.autoMode).toBe(false);
    // Light meaning is model-dependent now, so the raw value is what's parsed.
    expect(s.lightRaw).toBe(0);
    expect(isLightOn(s.lightRaw, 'onOff')).toBe(false);
    expect(s.buttonLock).toBe(true);
  });

  it('treats eco as an automatic mode, since HomeKit has only auto/manual', () => {
    expect(parsePurifierState({ ...base, status: { ...base.status, '0002': 6 } }).autoMode).toBe(true);
    expect(parsePurifierState({ ...base, status: { ...base.status, '0002': 1 } }).autoMode).toBe(true);
    expect(parsePurifierState({ ...base, status: { ...base.status, '0002': 5 } }).autoMode).toBe(false);
  });

  it('converts filter sensor readings from "used" to "remaining" percent', () => {
    // Coway reports consumption; HomeKit's FilterLifeLevel wants life left.
    const s = parsePurifierState({ ...base, sensor: { ...base.sensor, '0011': 100, '0012': 30 } });
    expect(s.preFilterPct).toBe(0);
    expect(s.max2Pct).toBe(70);
  });

  it('leaves filter percentages undefined when the sensor omits them', () => {
    const s = parsePurifierState({ ...base, sensor: { '0002': 5 } });
    expect(s.preFilterPct).toBeUndefined();
    expect(s.max2Pct).toBeUndefined();
  });
});

describe('toRotationSpeed / fromRotationSpeed', () => {
  it('maps the three Coway fan steps onto evenly spaced HomeKit percentages', () => {
    expect(toRotationSpeed(0)).toBe(0);
    expect(toRotationSpeed(1)).toBe(33);
    expect(toRotationSpeed(2)).toBe(67);
    expect(toRotationSpeed(3)).toBe(100);
  });

  it('round-trips every step', () => {
    for (const step of [1, 2, 3]) {
      expect(fromRotationSpeed(toRotationSpeed(step))).toBe(String(step));
    }
  });

  it('snaps arbitrary slider positions to the nearest real step', () => {
    expect(fromRotationSpeed(1)).toBe('1');
    expect(fromRotationSpeed(50)).toBe('2');
    expect(fromRotationSpeed(90)).toBe('3');
  });
});

describe('toAirQuality', () => {
  it('maps Coway grades 1-4 onto the HomeKit 1-5 scale', () => {
    expect(toAirQuality(1)).toBe(1); // EXCELLENT
    expect(toAirQuality(2)).toBe(3); // FAIR
    expect(toAirQuality(3)).toBe(4); // INFERIOR
    expect(toAirQuality(4)).toBe(5); // POOR
  });

  it('reports UNKNOWN rather than guessing when the grade is missing or unexpected', () => {
    expect(toAirQuality(undefined)).toBe(0);
    expect(toAirQuality(99)).toBe(0);
  });
});

describe('filter life, across the sources different models populate', () => {
  const payload = (sensor: Record<string, number>) => ({
    status: { '0001': 1, '0002': 1 },
    sensor,
    network: { wifiConnected: true },
    iaqGrade: 1,
  });

  it('prefers Coway\'s supplies endpoint when it returns readings', () => {
    const s = parsePurifierState(payload({ '0011': 100, '0012': 100 }), [
      { name: 'Pre-Filter', remainPct: 62 },
      { name: 'Max2', remainPct: 41 },
    ]);
    expect(s.preFilterPct).toBe(62);
    expect(s.max2Pct).toBe(41);
  });

  it('falls back to sensor attributes when the endpoint returns nothing', () => {
    // The 250S has no working supplies endpoint yet, so sensors are all it has.
    const s = parsePurifierState(payload({ '0011': 30, '0012': 20 }), []);
    expect(s.preFilterPct).toBe(70);
    expect(s.max2Pct).toBe(80);
  });

  it('reports the odor filter that UK and EU models carry', () => {
    const s = parsePurifierState(payload({ '0011': 10, '0013': 25 }));
    expect(s.odorFilterPct).toBe(75);
  });

  it('leaves the odor filter undefined on models without one', () => {
    expect(parsePurifierState(payload({ '0011': 10 })).odorFilterPct).toBeUndefined();
  });

  it('matches the pre-filter by name and treats any other supply as the main filter', () => {
    const s = parsePurifierState(payload({}), [
      { name: 'Max2', remainPct: 55 },
      { name: 'Pre-Filter', remainPct: 90 },
    ]);
    expect(s.preFilterPct).toBe(90);
    expect(s.max2Pct).toBe(55);
  });
});

describe('light conventions', () => {
  it('reads the verified 400S convention, where 2 is on', () => {
    expect(isLightOn(2, 'onOff')).toBe(true);
    expect(isLightOn(0, 'onOff')).toBe(false);
  });

  it('reads the 250S/IconS enum convention, where 0 is on and 2 is off', () => {
    expect(isLightOn(0, 'mode')).toBe(true);
    expect(isLightOn(2, 'mode')).toBe(false);
    expect(isLightOn(3, 'mode')).toBe(true); // half-off is still lit
  });

  it('emits the right value for each convention when switching on', () => {
    expect(lightCommand(true, 'onOff')).toBe('2');
    expect(lightCommand(false, 'onOff')).toBe('0');
    expect(lightCommand(true, 'mode')).toBe('0');
    expect(lightCommand(false, 'mode')).toBe('2');
  });

  it('detects the enum convention from values only it can produce', () => {
    // 0 and 2 are ambiguous; 1 (AQI-off) and 3 (half-off) are not.
    expect(detectLightConvention(1)).toBe('mode');
    expect(detectLightConvention(3)).toBe('mode');
    expect(detectLightConvention(0)).toBeUndefined();
    expect(detectLightConvention(2)).toBeUndefined();
  });
});
