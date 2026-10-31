# homebridge-deye-inverter

A Homebridge plugin that exposes three HomeKit temperature sensors (**DC Temperature**, **AC Temperature**, and **Battery Temperature**) and an **Grid** contact sensor for grid power availability.
Designed for the **Deye SUN-6K-SG05LP1-EU-SM2-P** inverter over Modbus TCP.

Open your logger settings, **enable Modbus**, and enter the logger's IP address in the plugin settings. The default port is `502`.

The plugin reads holding registers (FC03): DC `90`, AC/heatsink `91`, and battery `182`, using `(raw - 1000) / 10` to convert values to °C. It only reads data and does not change inverter settings.

**Grid** reads grid-side L1-N voltage from register `150`, using `raw / 10` volts as documented in the [Deye Modbus protocol](https://www.photovoltaikforum.com/core/attachment/449240-deye-modbus-protocol-v118-pdf/). In Apple Home, **Closed** means **Grid On** (grid power present) and **Open** means **Grid Off** (grid power absent). The contact closes at **100 V or above** and opens **below 80 V**; between these thresholds it keeps its previous state to avoid rapid toggling. On startup, it requires at least 100 V to report power present. This detects voltage at the Grid input, not whether the inverter has connected its grid relay or whether voltage meets grid quality limits. A generator connected to that input would also be detected as power present.

The new contact sensor has been tested with a simulated logger and Homebridge; its voltage reading and outage detection still need verification on the physical inverter. A missing voltage word (`0xffff`) or communication failure reports a sensor error instead of a power outage. Polling resumes automatically after a failure.

## Tested model

All three temperatures have been successfully read from a **Deye SUN-6K-SG05LP1-EU-SM2-P** through a logger with Modbus enabled on port `502`.
One live reading returned **62.4°C DC**, **55.9°C AC**, and **34.0°C battery**. These are readings from that test, not fixed values.

The Homebridge integration has been tested with the Homebridge API/HAP and a simulated logger. Pairing with Apple Home has not yet been tested on a live installation.

## Installation

Requires Node.js 22.10+ within the 22.x series, or Node.js 24.x, and Homebridge 1.8+ or 2.x.
Once published to npm, search for **homebridge-deye-inverter** in the Homebridge UI and install it, or run:

```sh
npm install -g homebridge-deye-inverter
```

To activate the plugin:

1. Open **Homebridge UI → Plugins → Deye Inverter → Plugin Config**.
2. Enter your logger's IP address.
3. Click **Save**, then **Restart Homebridge**.

The logger IP field starts empty and must be filled in. The UI saves the platform configuration for you. No manual JSON editing is needed. Installing the package alone does not activate the sensors; the plugin logs **SETUP REQUIRED** with these steps if its platform has not started. A platform with a missing or blank IP also logs setup instructions and does not attempt to connect or create sensors.

For reference, the saved platform configuration looks like this:

```json
{
  "platform": "DeyeInverter",
  "host": "192.168.5.190"
}
```

Restart Homebridge. The four sensors will be available through the bridge paired with Apple Home.
The machine running Homebridge must be able to reach the logger's IP address and port.

Only the logger's IP address is needed. The port is optional and can be changed under **Advanced settings** in the Homebridge UI.

| Setting | Default | Description |
| --- | --- | --- |
| `host` | None — required | Logger IP address or hostname |
| `port` | `502` | Modbus TCP port |

The plugin waits 10 seconds after each polling cycle completes before starting the next cycle. Each request has a 5-second timeout, and requests never overlap. No polling or timeout configuration is needed. Failed sensors report a communication error instead of serving stale readings, and recover automatically after a successful read. Grid power changes are detected on the next successful voltage read, not instantaneously.

AC refers to the inverter's heatsink sensor. Battery temperature is the value reported by the inverter, not individual BMS cell temperatures.
The plugin uses the inverter's default communication address of `1`, which worked with the tested model. You do not need to find or configure this address.

Sensor names are **DC Temperature**, **AC Temperature**, **Battery Temperature**, and **Grid**. You can rename them in Apple Home.
The plugin preserves sensor identities when the logger's IP address changes. Each platform configuration supports one inverter.

## Development and local installation

```sh
npm ci
npm run typecheck
npm test
npm run test:homebridge
npm pack
```

`npm pack` builds the plugin and creates `homebridge-deye-inverter-1.0.3.tgz`. Install the local package on your Homebridge machine with:

```sh
npm install -g ./homebridge-deye-inverter-1.0.3.tgz
```

A CLI is also available to test the logger directly from the source checkout:

```sh
npm start -- --once
npm start
npm start -- --grid-only
```

The CLI supports a `.env` file based on `.env.example`. Homebridge uses the platform settings above, not `.env`.
The single-phase CLI also logs `gridVoltageV`, `grid` (`On`/`Off`), `contact` (`Closed`/`Open`), and the raw Grid register. Use `--grid-only` to read just Grid for live outage testing, or combine it with `--once` for one reading. It uses the same 100 V / 80 V thresholds as Homebridge. For the three-phase CLI profile, Grid is omitted unless you explicitly supply a model-appropriate `GRID_REGISTER`. A read failure logs an error rather than an `Off` reading.
After `npm run build`, use `npm run serve -- --once` to run the compiled CLI.
Unit tests use a simulated Modbus TCP logger and the Homebridge API/HAP, including grid voltage thresholds, outage detection, and fault recovery. `npm run test:homebridge` also starts an isolated real Homebridge instance, loads the compiled plugin, and verifies all four sensors through its HAP endpoint and persisted accessory cache. Tests do not access a real inverter.

## Troubleshooting missing sensors

Installing the package alone does not enable its platform. Save the configuration shown above in Homebridge, then restart Homebridge. The platform name must be `DeyeInverter`.

The plugin logs `Plugin loaded (Homebridge ..., Node ...)` as soon as Homebridge invokes the plugin entry point, even before platform configuration is loaded. If no platform starts in that process, it logs **SETUP REQUIRED** and the exact Homebridge UI steps to activate the plugin, with a reminder to check child bridge logs when applicable.

Platform startup logs include `Starting DeyeInverter platform`, the logger address, `Added accessory:` or `Restored accessory:` for each sensor, and `Ready: DC Temperature, AC Temperature, Battery Temperature, Grid`. The first successful reading and recovery after a failed read are logged at the normal info level; subsequent readings use debug logging. Read failures include the logger address, register, and error.
If the initialization line is missing, check that the platform configuration was saved and the plugin is enabled. If there is a load error, inspect the preceding Homebridge logs.

If you enabled a child bridge, pair that child bridge with Apple Home separately using its QR code. Otherwise, the sensors are exposed through your existing main bridge. The sensors are registered before any Modbus reads, so a logger connection error should produce unresponsive sensors rather than prevent their creation.

## GitHub Actions and npm publishing

- `ci.yml`: runs TypeScript checks, tests, and package validation on Node.js 22 and 24 for every push and pull request.
- `publish.yml`: runs checks and publishes to npm when a **non-prerelease GitHub Release is published**. The release tag must match `v` followed by the version in `package.json`.
- The publishing workflow sets `repository.url` from the GitHub repository it runs in. Do not commit tokens to source control.

Initial setup:

1. Push the source to your GitHub repository. Check that the package name `homebridge-deye-inverter` is available on npm. If you rename the package, also update `PLUGIN_NAME` in `src/platform.ts`.
2. For the first publication through Actions, create an npm granular access token with package publishing permissions and 2FA bypass enabled. Save it as the GitHub repository Actions secret **`NPM_TOKEN`**.
3. Commit the package version and `package-lock.json`, create a `v1.0.0` tag pointing to that commit, and publish a GitHub Release for the tag. The workflow will publish version `1.0.0`.
4. Once the package exists, you can switch to **npm Trusted Publishing**. In the npm package settings, configure the exact GitHub owner, repository, and workflow filename **`publish.yml`**. If prompted for an allowed action, select publishing. Leave the environment unset because this workflow does not use one. Remove the `NPM_TOKEN` secret after configuring OIDC; the workflow already has `id-token: write` permission and uses Node.js 24.

For later releases, run `npm version patch` in a clean Git working tree, push the commit and tag, then publish a GitHub Release for the new tag. An existing npm version cannot be published again.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [Homebridge dynamic platform API](https://developers.homebridge.io/homebridge/interfaces/DynamicPlatformPlugin.html).
