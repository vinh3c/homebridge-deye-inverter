# homebridge-deye-inverter

A read-only Homebridge plugin exposing eight Matter accessories over Modbus TCP: three temperatures and five electrical branches. Matter runs inside Homebridge.

The mapping targets compatible single-phase hybrid inverters. Earlier temperature, SOC and PV readings were checked on SUN-6K-SG05LP1-EU-SM2-P; the newly added electrical registers still need comparison with the inverter display. Other models are not automatically supported. Accessory metadata remains generic.

| Accessory | Power (W) register | Voltage register / scale | Current register / scale |
| --- | --- | --- | --- |
| PV1 (DC) | 186 | 109 / 0.1 V | 110 / 0.1 A |
| PV2 (DC) | 187 | 111 / 0.1 V | 112 / 0.1 A |
| Grid Power (AC) | 169 | 150 / 0.1 V | 160 / 0.01 A |
| Load Power (AC) | 178 | 157 / 0.1 V | 179 / 0.01 A |
| Battery Power (DC) | 190 | 183 / 0.01 V | 191 / 0.01 A |

Power is read directly, never calculated from voltage times current. Grid power is positive for import and negative for export. Battery output power/current are positive for discharge and negative for charge. Grid, Load and Battery power/current are signed 16-bit words: raw 65535 means -1, not unavailable. Unsigned measurements use 65535 as unavailable; zero is valid. Grid uses internal metering (not external CT registers 170–172). Load power is the reported total load; its scope depends on wiring and metering. These total/L1 combinations apply to the single-phase map.

The mapping follows the [Deye Modbus protocol](https://www.photovoltaikforum.com/core/attachment/449240-deye-modbus-protocol-v118-pdf/). All requests use FC03; the plugin never writes inverter settings.

| Other accessory/detail | Register | Reading |
| --- | --- | --- |
| DC Temperature | 90 | (raw - 1000) / 10 °C |
| AC Temperature | 91 | (raw - 1000) / 10 °C |
| Battery Temperature | 182 | (raw - 1000) / 10 °C |
| Battery SOC detail | 184 | 0–100%, on Battery Temperature only |

## Installation and upgrade

Requires Homebridge >=2.2 and <3, Node.js ^22.10 or ^24, and Matter enabled on the bridge or child bridge running this plugin.

1. Install the plugin through Homebridge UI and enable Modbus on the logger.
2. Open **Plugins → Deye Inverter → Plugin Config**, enter the logger IP address, save and restart Homebridge.
3. Use the Matter connection for the bridge in Apple Home.

Configuration: platform DeyeInverter, required host, optional port (default 502). The plugin uses unit ID 1 and a five-second request timeout. It does not change pairing or bridge settings.

This version removes **Grid contact**, **Total Consumption Energy**, **Total Import Energy** and combined **PV**. After all five replacement electrical endpoints are ready, their old cached accessories are unregistered. PV1/PV2 reuse existing identities when available. Temperature identities remain unchanged. Names, room assignments and automations for removed accessories may need updating. Cached HAP sensors are removed only after the Matter replacements are ready. All current Matter accessories re-register ownership on every startup.

Each electrical branch publishes W, A and V on one ElectricalSensor, internally in mW/mA/mV. Earlier combined PV watts were observed in Apple Home; display of the new endpoints and A/V still needs verification on the deployed bridge. Homebridge UI 5.29.0 uses an unknown-device tile for ElectricalSensor and may show no values. Successful endpoint tests do not establish Apple Home presentation. Cumulative energy is no longer published or polled.

## Polling and failure handling

Full single-phase polls use six sequential groups: **90–91**, **109–112**, **150**, **157–160**, **169**, **178–191** (26 words). There are no overlapping requests. Independent groups continue after a failure. The next poll starts ten seconds after completion.

A failed register group clears affected electrical attributes to null while preserving independent values. An incomplete branch is marked unreachable and retried next cycle. Failed Matter updates also clear stale electrical state. Successful first readings and recoveries log at info level, subsequent readings at debug level. Logs include raw words and register addresses.

Temperature uses hundredths of a degree inside Matter; invalid readings become null/unreachable. Grid voltage is available on Grid Power. Zero watts alone does not imply an outage: the grid can be energized without import/export. Voltage indicates voltage presence, not relay state or grid quality. The derived Grid On/Off contact and CLI grid/contact fields have been removed.

Storage battery SOC remains a detail on Battery Temperature through PowerSource, using half-percent units internally. Its endpointList contains only that accessory's actual assigned endpoint. Initialization clears cached SOC and scopes the source before readiness; the battery type is rebuilt with its existing UUID on each startup because Homebridge does not serialize custom initializers. SOC errors do not discard a valid temperature. No electrical branch carries this battery source. This is not a declared native BatteryStorage device or a verified battery UI/chart.

## CLI checks

The CLI reads Modbus only and starts no bridge or pairing workflow. It loads .env; Homebridge uses its UI configuration instead.

~~~sh
npm start -- --once
npm start -- --grid-only --once
~~~

Full single-phase JSON includes temperatures, batteryPercent, and pv1PowerW/pv1VoltageV/pv1CurrentA, pv2 equivalents, gridPowerW/gridVoltageV/gridCurrentA, load equivalents, battery equivalents. It includes raw words, register addresses and actual request groups. --grid-only remains a voltage-only diagnostic. The retired --energy-only flag reports an error. Three-phase CLI temperature profiles omit these single-phase electrical branches and need a model-appropriate GRID_REGISTER for voltage readings.

For foreground observation, omit --once and stop with Ctrl+C. Preserve existing log tails by appending:

~~~powershell
npm start | Tee-Object -FilePath .local/deye.log -Append
~~~

## Development checks

~~~sh
npm run typecheck
npm test
npm run test:matter
npm pack
~~~

Unit tests use a simulated logger for decoding, batching, fault recovery, cache migration, SOC scope and shutdown. The Matter integration uses real Homebridge endpoints with a simulated network and loopback logger. It covers fresh startup, legacy battery/contact/PV/energy cache migration, and scoped-cache restart, checks ownership and endpoint identity, and verifies W/A/V units and AC/DC mode. No Matter UDP sockets, LAN advertisements, physical inverter access or Apple Home pairing are used by these tests.

## GitHub Actions and npm publishing

- `ci.yml`: runs TypeScript checks, tests, and package validation on Node.js 22 and 24 for every push and pull request.
- `publish.yml`: runs checks and publishes to npm when a **non-prerelease GitHub Release is published**. Use a stable release tag such as `v1.0.4`; the workflow automatically sets the version in `package.json` and `package-lock.json` from that tag before running checks and publishing. These version changes happen only in the workflow checkout; they do not create a commit or move the tag.
- The publishing workflow sets `repository.url` from the GitHub repository it runs in. Do not commit tokens to source control.

Initial setup:

1. Push the source to your GitHub repository. Check that the package name `homebridge-deye-inverter` is available on npm. If you rename the package, also update `PLUGIN_NAME` in `src/platform.ts`.
2. For the first publication through Actions, create an npm granular access token with package publishing permissions and 2FA bypass enabled. Save it as the GitHub repository Actions secret **`NPM_TOKEN`**.
3. Push the code, create a `v1.0.0` tag pointing to that commit, and publish a GitHub Release for the tag. The workflow will automatically set and publish version `1.0.0`.
4. Once the package exists, you can switch to **npm Trusted Publishing**. In the npm package settings, configure the exact GitHub owner, repository, and workflow filename **`publish.yml`**. If prompted for an allowed action, select publishing. Leave the environment unset because this workflow does not use one. Remove the `NPM_TOKEN` secret after configuring OIDC; the workflow already has `id-token: write` permission and uses Node.js 24.

For later releases, push the code and publish a GitHub Release with the next unused stable tag (for example, `v1.0.4`). No manual package version update is required. The tagged commit must contain this workflow change; rerunning an older failed release still uses its old workflow. An existing npm version cannot be published again.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [Homebridge dynamic platform API](https://developers.homebridge.io/homebridge/interfaces/DynamicPlatformPlugin.html).
