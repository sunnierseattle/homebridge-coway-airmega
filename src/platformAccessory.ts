import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { CowayClient, PurifierDevice } from './cowayClient.js';
import type { CowayPlatform } from './platform.js';
import {
  fromRotationSpeed, toAirQuality, toRotationSpeed, type PurifierState,
} from './purifierState.js';
import { Attr, Mode } from './settings.js';

/**
 * One Airmega, exposed as an air purifier plus its air-quality sensor, two
 * filter indicators and (optionally) the panel light.
 *
 * Every characteristic reads from `state`, a snapshot the platform refreshes on
 * a timer. HomeKit reads characteristics in bursts, and serving each one from
 * the cloud directly would turn a single tile render into a dozen requests.
 */
export class AirmegaAccessory {
  private readonly purifier: Service;
  private readonly airQuality: Service;
  private readonly preFilter: Service;
  private readonly max2Filter: Service;
  private readonly light?: Service;

  private state?: PurifierState;

  constructor(
    private readonly platform: CowayPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: CowayClient,
    private readonly device: PurifierDevice,
  ) {
    const { Service, Characteristic } = platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Coway')
      .setCharacteristic(Characteristic.Model, device.productModel)
      .setCharacteristic(Characteristic.SerialNumber, device.deviceSerial);

    this.purifier = this.accessory.getService(Service.AirPurifier)
      ?? this.accessory.addService(Service.AirPurifier, device.nickname);

    this.purifier.getCharacteristic(Characteristic.Active)
      .onGet(() => this.read((s) => (s.isOn ? 1 : 0), 0))
      .onSet((v) => this.send(Attr.POWER, v ? '1' : '0'));

    this.purifier.getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(() => this.read((s) => (s.isOn ? 2 : 0), 0)); // PURIFYING_AIR / INACTIVE

    this.purifier.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onGet(() => this.read((s) => (s.autoMode ? 1 : 0), 1))
      .onSet((v) => (v === 1
        ? this.send(Attr.MODE, Mode.AUTO)
        // Leaving auto has no direct command; selecting a fan speed is what
        // actually puts the unit into manual, so re-assert the current speed.
        : this.send(Attr.FAN_SPEED, fromRotationSpeed(toRotationSpeed(this.state?.fanSpeed ?? 1)))));

    this.purifier.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minStep: 33 })
      .onGet(() => this.read((s) => toRotationSpeed(s.fanSpeed), 0))
      .onSet((v) => (Number(v) === 0
        ? this.send(Attr.POWER, '0')
        : this.send(Attr.FAN_SPEED, fromRotationSpeed(Number(v)))));

    this.purifier.getCharacteristic(Characteristic.LockPhysicalControls)
      .onGet(() => this.read((s) => (s.buttonLock ? 1 : 0), 0))
      .onSet((v) => this.send(Attr.LOCK, v ? '1' : '0'));

    this.airQuality = this.accessory.getService(Service.AirQualitySensor)
      ?? this.accessory.addService(Service.AirQualitySensor, `${device.nickname} Air Quality`);
    this.airQuality.getCharacteristic(Characteristic.AirQuality)
      .onGet(() => this.read((s) => toAirQuality(s.aqGrade), 0));
    this.airQuality.getCharacteristic(Characteristic.PM10Density)
      .onGet(() => this.read((s) => s.pm10 ?? 0, 0));

    this.preFilter = this.filterService('Pre-Filter');
    this.max2Filter = this.filterService('Max2 Filter');
    this.bindFilter(this.preFilter, (s) => s.preFilterPct);
    this.bindFilter(this.max2Filter, (s) => s.max2Pct);

    if (platform.config.exposeLight) {
      this.light = this.accessory.getService(Service.Lightbulb)
        ?? this.accessory.addService(Service.Lightbulb, `${device.nickname} Light`);
      this.light.getCharacteristic(Characteristic.On)
        .onGet(() => this.read((s) => s.lightOn, false))
        .onSet((v) => this.send(Attr.LIGHT, v ? '2' : '0'));
    }
  }

  private filterService(name: string): Service {
    const { Service } = this.platform;
    const subtype = name.toLowerCase().replace(/\W+/g, '-');
    return this.accessory.getServiceById(Service.FilterMaintenance, subtype)
      ?? this.accessory.addService(Service.FilterMaintenance, `${this.device.nickname} ${name}`, subtype);
  }

  private bindFilter(service: Service, pick: (s: PurifierState) => number | undefined): void {
    const { Characteristic } = this.platform;
    service.getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.read((s) => ((pick(s) ?? 100) <= 0 ? 1 : 0), 0));
    service.getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => this.read((s) => pick(s) ?? 100, 100));
  }

  /**
   * Serve a characteristic from the last snapshot. Before the first poll lands
   * we return `fallback` rather than blocking HomeKit on a cloud round-trip.
   */
  private read<T extends CharacteristicValue>(pick: (s: PurifierState) => T, fallback: T): T {
    return this.state ? pick(this.state) : fallback;
  }

  private async send(attribute: string, value: string): Promise<void> {
    await this.client.control(this.device, attribute, value);
    // Coway needs a moment before the status page reflects the change, so
    // update optimistically and let the next poll correct us if it disagrees.
    if (this.state) {
      if (attribute === Attr.POWER) {
        this.state.isOn = value === '1';
      }
      if (attribute === Attr.FAN_SPEED) {
        this.state.fanSpeed = Number(value);
      }
      if (attribute === Attr.MODE) {
        this.state.autoMode = value === Mode.AUTO || value === Mode.ECO;
      }
      if (attribute === Attr.LIGHT) {
        this.state.lightOn = value === '2';
      }
      if (attribute === Attr.LOCK) {
        this.state.buttonLock = value === '1';
      }
    }
  }

  /** Pull one fresh snapshot and push it into every characteristic. */
  async refresh(): Promise<void> {
    const { Characteristic } = this.platform;
    try {
      const s = await this.client.readState(this.device);
      this.state = s;

      this.purifier.updateCharacteristic(Characteristic.Active, s.isOn ? 1 : 0);
      this.purifier.updateCharacteristic(Characteristic.CurrentAirPurifierState, s.isOn ? 2 : 0);
      this.purifier.updateCharacteristic(Characteristic.TargetAirPurifierState, s.autoMode ? 1 : 0);
      this.purifier.updateCharacteristic(Characteristic.RotationSpeed, toRotationSpeed(s.fanSpeed));
      this.purifier.updateCharacteristic(Characteristic.LockPhysicalControls, s.buttonLock ? 1 : 0);

      this.airQuality.updateCharacteristic(Characteristic.AirQuality, toAirQuality(s.aqGrade));
      this.airQuality.updateCharacteristic(Characteristic.PM10Density, s.pm10 ?? 0);
      // Not every model has a PM2.5 sensor (the 400S reports only PM10).
      // Publishing a permanent 0 would read as pristine air, so the
      // characteristic only appears once the device actually reports a value.
      if (s.pm25 !== undefined) {
        this.airQuality.updateCharacteristic(Characteristic.PM2_5Density, s.pm25);
      }

      this.updateFilter(this.preFilter, s.preFilterPct);
      this.updateFilter(this.max2Filter, s.max2Pct);
      this.light?.updateCharacteristic(Characteristic.On, s.lightOn);
    } catch (err) {
      this.platform.log.debug(`Poll failed for ${this.device.nickname}: ${(err as Error).message}`);
    }
  }

  private updateFilter(service: Service, pct: number | undefined): void {
    const { Characteristic } = this.platform;
    service.updateCharacteristic(Characteristic.FilterLifeLevel, pct ?? 100);
    service.updateCharacteristic(Characteristic.FilterChangeIndication, (pct ?? 100) <= 0 ? 1 : 0);
  }
}
