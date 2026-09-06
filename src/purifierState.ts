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

export interface PurifierState {
  isOn: boolean;
  autoMode: boolean;
  nightMode: boolean;
  rapidMode: boolean;
  ecoMode: boolean;
  fanSpeed: number;
  lightOn: boolean;
  buttonLock: boolean;
  online: boolean;
  /** Percent of filter life remaining, or undefined when unreported. */
  preFilterPct?: number;
  max2Pct?: number;
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

export function parsePurifierState(payload: StatusPayload): PurifierState {
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
    lightOn: status[Attr.LIGHT] === 2,
    buttonLock: status[Attr.LOCK] === 1,
    online: network.wifiConnected !== false,
    preFilterPct: remaining(sensor['0011']),
    max2Pct: remaining(sensor['0012']),
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
