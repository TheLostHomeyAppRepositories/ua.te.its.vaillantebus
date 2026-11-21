# Vaillant eBUS for Homey Pro

Local monitoring and control of Vaillant boilers (BAI burner control: ecoTEC, turboTEC, atmoTEC …) over eBUS — no cloud.

[☕ Support the project](#support)

Tested with **Vaillant BAI00, SW 0403 / HW 0903** (no room controller on the bus).

## What it does

| Capability | Source |
|---|---|
| Flow / return / hot-water temperature | d.40, d.41, d.03 |
| Water pressure (bar) | `b509 0d0200` |
| Flame, modulation, hot-water demand | `b509` registers |
| Current faults (F.xx) + alarm | `b503 0001` |
| **Heating flow setpoint** (writable) | `b510 00` SetMode, as a VRC controller sends it |
| **Hot-water setpoint** (writable) | `b510 00` SetMode |
| Heating on/off (writable) | SetMode disable bit |
| *Controlled by Homey* toggle | on: setpoint re-sent every 60 s (overrides the panel); off: Homey only shows the boiler's setpoint |

Flow cards: flame on/off, error changed, pressure changed; conditions flame is on, pressure below; actions set flow / hot-water setpoint, control on/off.

### Notes from the real boiler

* The boiler display keeps showing the **panel** setpoint. The value actually used is diagnostics **d.05** — that is what this app sets and reads.
* The bus setpoint is **not** limited by the panel value (45 °C was accepted with the panel at 39 °C).
* **A bus setpoint stays valid for about 15 minutes after the last SetMode.** While it is valid the panel is ignored; afterwards the boiler falls back to its panel value (observed: last bus command 21:12, panel value taken over at 21:27; panel changes made in between had no effect). While Homey is in control it re-sends every minute, so the panel has no say; switching control off hands the boiler back to its panel after ~15 min.
* There is no readable "panel" register: a register sweep (`tools/scan-registers.js`) found only d.05 and its mirror `03e8`.

## Hardware

Homey reaches the boiler through an eBUS adapter on the boiler's eBUS terminals (2 wires, polarity does not matter):

1. **Wi-Fi / Ethernet, no PC** — an ebusd.eu adapter (v5, Shield C5, Shield C6, Stick C6): update its firmware,
   connect it to your Wi-Fi (it opens an open AP named `EBUS`, then http://192.168.4.1) and point this app at its IP
   on port 9999 with connection type *Adapter, enhanced protocol*. The enhanced protocol is the adapter's free
   standard mode — the paid token is only for *micro-ebusd*, which this app does not use. *Not yet tested on hardware.*
2. **USB** — the same ebusd.eu adapters over USB, or any other ebusd-compatible USB eBUS adapter, on a Raspberry Pi /
   always-on PC running ebusd with `--enablehex`:
   `ebusd -d /dev/ttyUSB0 --port=8888 --enablehex --scanconfig`. Homey itself cannot use USB devices.

## Room, outdoor and valve inputs

Homey's App Store does not allow a device app to read other apps' devices (`homey:manager:api`), so the room
controller gets its inputs from the user's Flows:

| Flow action card | Used for |
|---|---|
| *Report room temperature [t] from [sensor]* | room correction; several named sensors are averaged |
| *Report outdoor temperature [t]* | heating curve; without it the weather for Homey's location (Open-Meteo) is used |
| *Zone valve [1–8] is [open/closed]* | heat demand; set *Zone valves* (count) in the device settings |

Readings older than the *Sensor timeout* device setting (default 180 min) are ignored.

## Development

```
npm test                                     # offline protocol tests (captured telegrams)
node tools/probe.js ebusd 127.0.0.1 8888     # read the boiler without Homey
node tools/probe.js ebusd 127.0.0.1 8888 --set 40 46   # send SetMode once
homey app run                                # run on your Homey Pro
```

Message definitions are taken from [ebusd-configuration](https://github.com/john30/ebusd-configuration) (`vaillant/08.bai.csv`).

## Support

If this app keeps your boiler in check, you can buy me a coffee 💛

[![Support via Monobank](https://img.shields.io/badge/☕_Buy_me_a_coffee-Monobank-000000?style=for-the-badge)](https://send.monobank.ua/jar/7Zv7oTCnWc)

Any Visa / Mastercard, Apple Pay or Google Pay works, from any country.

## License

MIT © vova275
