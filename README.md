# homebridge-deye-inverter

A Homebridge plugin that exposes three separate HomeKit temperature sensors: **DC Temperature**, **AC Temperature**, and **Battery Temperature**.
Designed for the **Deye SUN-6K-SG05LP1-EU-SM2-P** inverter over Modbus TCP.

Open your logger settings, **enable Modbus**, and enter the logger's IP address in the plugin settings. The default port is `502`.

The plugin reads holding registers (FC03): DC `90`, AC/heatsink `91`, and battery `182`, using `(raw - 1000) / 10` to convert values to °C. It only reads data and does not change inverter settings.

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

Configure the plugin through its Settings page, or add this entry to the `platforms` array in your Homebridge `config.json`:

```json
{
  "platform": "DeyeInverter",
  "host": "192.168.5.60"
}
```

Restart Homebridge. The three sensors will be available through the bridge paired with Apple Home.
The machine running Homebridge must be able to reach the logger's IP address and port.

Only the logger's IP address is needed. The port is optional and can be changed under **Advanced settings** in the Homebridge UI.

| Setting | Default | Description |
| --- | --- | --- |
| `host` | `192.168.5.60` | Logger IP address or hostname |
| `port` | `502` | Modbus TCP port |

The plugin waits 10 seconds after each polling cycle completes before starting the next cycle. Each request has a 5-second timeout, and requests never overlap. No polling or timeout configuration is needed. Failed sensors report a communication error instead of serving stale temperatures, and recover automatically after a successful read.

AC refers to the inverter's heatsink sensor. Battery temperature is the value reported by the inverter, not individual BMS cell temperatures.
The plugin uses the inverter's default communication address of `1`, which worked with the tested model. You do not need to find or configure this address.

Sensor names are **DC Temperature**, **AC Temperature**, and **Battery Temperature**. You can rename them in Apple Home.
The plugin preserves sensor identities when the logger's IP address changes. Each platform configuration supports one inverter.

## Development and local installation

```sh
npm ci
npm run typecheck
npm test
npm run test:homebridge
npm pack
```

`npm pack` builds the plugin and creates `homebridge-deye-inverter-1.0.1.tgz`. Install the local package on your Homebridge machine with:

```sh
npm install -g ./homebridge-deye-inverter-1.0.1.tgz
```

A CLI is also available to test the logger directly from the source checkout:

```sh
npm start -- --once
npm start
```

The CLI supports a `.env` file based on `.env.example`. Homebridge uses the platform settings above, not `.env`.
After `npm run build`, use `npm run serve -- --once` to run the compiled CLI.
Unit tests use a simulated Modbus TCP logger and the Homebridge API/HAP. `npm run test:homebridge` also starts an isolated real Homebridge instance, loads the compiled plugin, and verifies all three sensors and temperatures through its HAP endpoint and persisted accessory cache. Tests do not access a real inverter.

## Troubleshooting missing sensors

Installing the package alone does not enable its platform. Save the configuration shown above in Homebridge, then restart Homebridge. The platform name must be `DeyeInverter`.

Version 1.0.1 logs `Plugin loaded (Homebridge ..., Node ...)` as soon as Homebridge invokes the plugin entry point, even before platform configuration is loaded. If no platform starts in that process, it logs `DeyeInverter was not initialized` with configuration guidance and a reminder to check child bridge logs.

Platform startup logs include `Starting DeyeInverter platform`, the logger address, `Added accessory:` or `Restored accessory:` for each sensor, and `Ready: DC Temperature, AC Temperature, Battery Temperature`. The first successful reading and recovery after a failed read are logged at the normal info level; subsequent readings use debug logging. Read failures include the logger address, register, and error.
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
