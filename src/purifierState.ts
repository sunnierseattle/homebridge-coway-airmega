import { CowayError } from './errors.js';
import { Attr, Mode } from './settings.js';

/** Raw attribute maps as Coway ships them: numeric codes to numeric values. */
export type AttributeMap = Record<string, number>;

export interface StatusPayload {
  status: AttributeMap;
  sensor: AttributeMap;
  network: { wifiConnected?: boolean };
  iaqGrade?: number;
}

/** How a model encodes attribute 0007. See LIGHT_CONVENTIONS below. */
export type LightConvention = 'onOff' | 'mode';

/** One filter as reported by Coway's supplies endpoint. */
export interface FilterReading {
  name: string;
  remainPct: number;
}

export interface PurifierState {
  isOn: boolean;
  autoMode: boolean;
  nightMode: boolean;
  rapidMode: boolean;
  ecoMode: boolean;
  fanSpeed: number;
  /** Raw attribute 0007. Its meaning depends on the model's convention. */
  lightRaw?: number;
  buttonLock: boolean;
  online: boolean;
  /** Percent of filter life remaining, or undefined when unreported. */
  preFilterPct?: number;
  max2Pct?: number;
  /** UK and EU models carry a third, odor filter. Undefined elsewhere. */
  odorFilterPct?: number;
  aqGrade?: number;
  pm10?: number;
  pm25?: number;
  lux?: number;
}

/** Walk a nested plain object, returning undefined instead of throwing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function get(obj: unknown, ...path: string[]): any {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Coway exposes no JSON status endpoint. The IoCare app renders device state in
 * a webview, and the only machine-readable copy is the Next.js payload embedded
 * in that page's script tags. We locate the one script carrying `sensorInfo`,
 * slice out its outermost JSON object and strip the escaping the framework adds.
 *
 * This is inherently brittle: a Coway front-end change can break it. It fails
 * loudly for that reason — a silent empty state would look like a purifier that
 * had turned itself off.
 */
export function extractStatusPayload(html: string): StatusPayload {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const carrier = scripts.find((s) => s.includes('sensorInfo'));
  if (!carrier) {
    throw new CowayError(
      'No status payload found in the IoCare page. The session may have expired, or Coway changed the page format.',
    );
  }

  const start = carrier.indexOf('{');
  const end = carrier.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new CowayError('Status payload script contained no JSON object.');
  }

  let parsed: { children?: unknown[] };
  try {
    parsed = JSON.parse(carrier.slice(start, end + 1).replace(/\\/g, ''));
  } catch (cause) {
    throw new CowayError(`Could not parse the IoCare status payload: ${(cause as Error).message}`);
  }

  const info = (parsed.children ?? []).find(
    (child): child is Record<string, never> => typeof child === 'object' && child !== null,
  );
  if (!info) {
    throw new CowayError('Status payload contained no device object.');
  }

  const node = info as Record<string, never>;
  const core: unknown[] = get(node, 'coreData') ?? [];
  const sensorHolder = core
    .map((entry) => get(entry as Record<string, never>, 'data'))
    .find((data) => data && typeof data === 'object' && 'sensorInfo' in (data as object));

  const detail = get(node, 'deviceModule', 'data', 'content', 'deviceModuleDetailInfo') ?? {};

  return {
    status: get(node, 'deviceStatusData', 'data', 'statusInfo', 'attributes') ?? {},
    sensor: get(sensorHolder as Record<string, never>, 'sensorInfo', 'attributes') ?? {},
    network: detail,
    iaqGrade: get(detail, 'airStatusInfo', 'iaqGrade'),
  };
}

/** Coway reports filter *consumption*; HomeKit's FilterLifeLevel wants life left. */
function remaining(used: number | undefined): number | undefined {
  return used === undefined ? undefined : 100 - used;
}

/**
 * Coway reports filter life two ways and no model populates both reliably.
 * The supplies endpoint is authoritative where it works; the sensor attributes
 * are the fallback for models whose endpoint Coway has not finished (the 250S).
 * Anything still unknown stays undefined, so callers can omit the service
 * rather than publish a reassuring and wrong 100%.
 */
function filterLife(
  endpoint: FilterReading[] | undefined,
  sensor: AttributeMap,
): Pick<PurifierState, 'preFilterPct' | 'max2Pct' | 'odorFilterPct'> {
  const pre = endpoint?.find((f) => /pre-?filter/i.test(f.name));
  const main = endpoint?.find((f) => !/pre-?filter/i.test(f.name));

  return {
    preFilterPct: pre?.remainPct ?? remaining(sensor['0011']),
    max2Pct: main?.remainPct ?? remaining(sensor['0012']),
    odorFilterPct: remaining(sensor['0013']),
  };
}

export function parsePurifierState(
  payload: StatusPayload,
  filters?: FilterReading[],
): PurifierState {
  const { status, sensor, network, iaqGrade } = payload;
  const mode = status[Attr.MODE];

  return {
    isOn: status[Attr.POWER] === 1,
    // Eco is a second automatic mode. HomeKit's TargetAirPurifierState has only
    // AUTO and MANUAL, so both auto and eco report as AUTO.
    autoMode: String(mode) === Mode.AUTO || String(mode) === Mode.ECO,
    nightMode: String(mode) === Mode.NIGHT,
    rapidMode: String(mode) === Mode.RAPID,
    ecoMode: String(mode) === Mode.ECO,
    fanSpeed: status[Attr.FAN_SPEED] ?? 0,
    lightRaw: status[Attr.LIGHT],
    buttonLock: status[Attr.LOCK] === 1,
    online: network.wifiConnected !== false,
    ...filterLife(filters, sensor),
    aqGrade: iaqGrade,
    pm10: sensor['0002'],
    pm25: sensor['0001'],
    lux: sensor['0007'],
  };
}

/** Coway's three fan steps, spread across HomeKit's 0-100 slider. */
export function toRotationSpeed(step: number): number {
  if (step <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((step / 3) * 100));
}

/** Snap a HomeKit slider position back onto the nearest real fan step. */
export function fromRotationSpeed(percent: number): string {
  const step = Math.min(3, Math.max(1, Math.round((percent / 100) * 3)));
  return String(step);
}

/**
 * Coway grades air 1 (good) to 4 (very unhealthy); HomeKit uses 1 (excellent)
 * to 5 (poor), with 0 meaning unknown. We skip HomeKit's GOOD (2) so the worst
 * Coway grade still reaches POOR.
 */
export function toAirQuality(grade: number | undefined): number {
  switch (grade) {
  case 1: return 1;
  case 2: return 3;
  case 3: return 4;
  case 4: return 5;
  default: return 0;
  }
}

/**
 * Attribute 0007 carries two contradictory conventions across the range, and a
 * reading of 0 or 2 is valid under both, so they cannot always be told apart.
 *
 *  - `onOff` (verified on the 400S): 2 is on, 0 is off.
 *  - `mode`  (250S, IconS): an enum where 0 is on, 1 is AQI-off, 2 is off and
 *            3 is half-off, which the IconS alone supports.
 */
export function isLightOn(raw: number | undefined, convention: LightConvention): boolean {
  if (raw === undefined) {
    return false;
  }
  return convention === 'onOff' ? raw === 2 : raw !== 2;
}

export function lightCommand(on: boolean, convention: LightConvention): string {
  if (convention === 'onOff') {
    return on ? '2' : '0';
  }
  return on ? '0' : '2';
}

/**
 * Values 1 and 3 exist only under the enum convention, so seeing one is proof.
 * 0 and 2 are ambiguous and yield undefined rather than a guess.
 */
export function detectLightConvention(raw: number | undefined): LightConvention | undefined {
  return raw === 1 || raw === 3 ? 'mode' : undefined;
}

/** A single Coway control call: one attribute, one value. */
export interface Command {
  attribute: string;
  value: string;
}

/**
 * Coway silently ignores a fan-speed or mode command sent to a powered-off
 * unit, which made the HomeKit slider look broken. These build the full command
 * sequence, prepending a power-on where one is needed. Order matters: the unit
 * must be on before the setting it enables.
 */
export const commandsFor = {
  speed(isOn: boolean, percent: number): Command[] {
    if (percent <= 0) {
      return [{ attribute: Attr.POWER, value: '0' }];
    }
    const cmds: Command[] = [];
    if (!isOn) {
      cmds.push({ attribute: Attr.POWER, value: '1' });
    }
    cmds.push({ attribute: Attr.FAN_SPEED, value: fromRotationSpeed(percent) });
    return cmds;
  },

  mode(isOn: boolean, mode: string): Command[] {
    const cmds: Command[] = [];
    if (!isOn) {
      cmds.push({ attribute: Attr.POWER, value: '1' });
    }
    cmds.push({ attribute: Attr.MODE, value: mode });
    return cmds;
  },
};
