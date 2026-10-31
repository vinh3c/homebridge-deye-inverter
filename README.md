# homebridge-deye-inverter

A Homebridge plugin that exposes **seven Matter accessories** for Deye inverters over Modbus TCP. Matter runs inside Homebridge; the plugin does not create HAP sensors.

The current Homebridge register map has been verified on a SUN-6K-SG05LP1-EU-SM2-P single-phase inverter. Other models require a compatible register map; support for every Deye model is not implied. Accessories use generic model metadata (`Modbus TCP Inverter`) rather than claiming a specific hardware model.

| Sensor | Holding registers (FC03) | Reading |
| --- | --- | --- |
| DC Temperature | 90 | `(raw - 1000) / 10` °C |
| AC Temperature | 91 | `(raw - 1000) / 10` °C; heatsink temperature |
| Battery Temperature | 182 | `(raw - 1000) / 10` °C |
| Battery Percent (on Battery Temperature) | 184 | Storage battery SOC, raw 0–100% |
| Grid | 150 | `raw / 10` V, exposed as a contact sensor |
| Total Consumption Energy | 85 low word + 86 high word | `(high * 65536 + low) / 10` kWh |
| Total Import Energy | 78 low word + 80 high word | `(high * 65536 + low) / 10` kWh; grid purchases |
| PV | 186 + 187 | Sum of reported PV input powers, W |

The plugin only reads the inverter and never writes its settings. The register mapping is documented in the [Deye Modbus protocol](https://www.photovoltaikforum.com/core/attachment/449240-deye-modbus-protocol-v118-pdf/).

## Requirements and installation

Requires Node.js 22.10+ in the 22.x series or Node.js 24.x, and **Homebridge 2.2 or newer (below 3.0)**. Matter must be enabled on the bridge running this plugin, including the child bridge when applicable.

Install `homebridge-deye-inverter` through Homebridge UI, or install a locally built package:

```sh
npm install -g ./homebridge-deye-inverter-1.0.3.tgz
```

1. Enable Modbus in the logger settings.
2. In **Homebridge UI → Plugins → Deye Inverter → Plugin Config**, enter the logger IP address.
3. Enable Matter on that Homebridge bridge or child bridge, save and restart.

All seven accessories use the Matter connection. The bridge's existing HAP connection does not expose them. Homebridge UI can list Matter accessories, but its upstream accessory renderer inspected on 2026-10-31 has no `ElectricalSensor` tile: PV and the two energy meters fall back to an unknown-device tile with no measurement values. This is a UI rendering limitation, not evidence of a failed Modbus read. See the [UI tile selector](https://github.com/homebridge/homebridge-config-ui-x/blob/latest/ui/src/app/core/accessories/accessory-tile/accessory-tile.component.html) and [fallback template](https://github.com/homebridge/homebridge-config-ui-x/blob/latest/ui/src/app/core/accessories/types/matter/unknown/unknown.component.html).

The user's Apple Home Power screen displays PV watts but no values for the cumulative energy meters. Cumulative kWh display remains unverified; do not infer it from successful Matter updates or promise energy charts. Power and energy are separate measurements: the plugin does not relabel cumulative kWh as instantaneous W to fill an empty tile.

| Setting | Default | Description |
| --- | --- | --- |
| `host` | Required | Logger IP address or hostname |
| `port` | `502` | Modbus TCP port |

The platform name is `DeyeInverter`. The plugin uses unit ID `1`, a five-second request timeout, and sequential requests. Full polls read three compact groups: **78–91**, **150**, and **182–187** (21 words total). Plugin cycles without an energy update read **90–91**, **150**, and **182–187** (9 words). The CLI full output always includes energy. The inverter also accepts one 110-word request spanning 78–187, but a small live comparison found similar latency for both approaches; compact groups transfer much less unused data and isolate request failures. Only requested metrics are decoded. Multiword counters stay in one request, and all requests respect the FC03 125-word limit. A failed group invalidates its associated readings while independent groups are still read. The plugin waits ten seconds after the polling cycle completes; energy is updated approximately once per minute. Missing host or disabled/unavailable Matter produces setup instructions without starting Modbus polling.

The **Battery Temperature** accessory also carries the inverter-reported storage battery SOC through Matter PowerSource. Matter uses half-percent units internally (`83%` is encoded as `166`); CLI/log output uses the actual percentage as `batteryPercent`. Invalid words (including `0xffff` or values above 100) clear the percentage to `null`, independently of temperature.

The PowerSource explicitly lists **only the Battery Temperature endpoint**. Older code left this list empty, which Matter defines as a source for the whole node, including PV and energy endpoints. The plugin now uses the number Matter actually assigns, scopes the source and clears cached SOC during endpoint initialization, then checks the scope before publishing a percentage. Each startup rebuilds the cached Battery Temperature endpoint with the same UUID because Homebridge does not preserve custom initializers in its accessory cache. The assigned scope is persisted with SOC updates. On the first upgrade, an old main-bridge cache can briefly appear before the plugin replaces it.

This corrects the source's scope; the exact Apple Home display after upgrade still needs verification. SOC remains a detail on Battery Temperature, not a declared native BatteryStorage device or a promised standalone battery tile/chart. The plugin preserves the physical storage battery reading rather than substituting a different sensor type. Homebridge logs `Battery SOC scope: Battery Temperature only (endpoint=…)` after checking local scope.

## Migrating from older plugin versions

Older versions exposed temperature and Grid through HomeKit HAP. This version replaces them with Matter sensors. Once all seven Matter endpoints are ready, the plugin unregisters its cached HAP accessories to avoid duplicates. It leaves the HAP cache in place if Matter is disabled or setup fails.

The Matter sensors have separate identities from the old HAP accessories. Room assignments, names and automations associated with the old accessories may need to be recreated. Other plugins and their HAP accessories are unaffected. The plugin does not modify Homebridge's bridge configuration or automatically pair any controller.

## Readings and failures

Matter temperatures are reported in **0.01°C** (`62.4°C` becomes `6240`). An unavailable reading becomes `null`, and the sensor is marked unreachable until a successful read. Cached readings are invalidated on startup.

Grid is **Closed / contact detected** when grid voltage reaches **100 V**, and **Open / contact not detected** when voltage falls below **80 V**. Between these thresholds it keeps its previous state. Matter `booleanState.stateValue = true` means Grid On. Startup requires at least 100 V. A missing voltage word (`0xffff`) or communication failure marks Grid unreachable instead of reporting a power outage. This measures voltage at the Grid input, not grid relay connection or grid quality.

Total Consumption Energy measures cumulative load consumption, including energy supplied from grid, solar and battery, rather than just grid purchases. The measured scope depends on the inverter's wiring and metering configuration. Read registers 85–86 together as an unsigned 32-bit number, low word first. CLI readings use `totalConsumptionEnergy`, and Homebridge logs use **Total Consumption Energy**. The internal Matter adapter converts the value to mWh and includes the observation timestamp. The plugin preserves the inverter's counter and does not compute daily differences or invent its start/reset date. Failed reads publish `null`, with automatic retry.

Each successful energy update is logged at info level, approximately once per minute, after reading back the applied Matter state (`Matter state confirmed`). This confirms the Homebridge endpoint state, not receipt or presentation by Apple Home. Other measurements log first successes and recoveries at info level and subsequent readings at debug level. Failures include the logger address and register. Live Modbus reads have confirmed temperatures and energy on the tested model (one observed energy reading was **568.1 kWh**, raw `[5681, 0]`). These are test observations, not fixed values.

### Diagnosing blank energy values in Apple Home

First check the logs of the Homebridge bridge or child bridge that is actually paired with Apple Home. Look for **both** `Total Consumption Energy: … kWh …; Matter state confirmed` and `Total Import Energy: … kWh …; Matter state confirmed`, or their read/update failure messages. CLI readings and logs from a different test bridge do not establish what the paired bridge publishes. Include the installed plugin version and Homebridge startup messages when reporting an issue; a local package archive can contain older code than the published release.

The current energy endpoints publish lifetime kWh counters without instantaneous watts. A blank entry in the **Power** screen alone does not identify an energy-delivery failure. Against Homebridge 2.4.0, declaring the energy attribute with an initial `null` enables the imported cumulative-energy features, mandatory accuracy metadata and PowerTopology. Changing the initial value to zero or adding invented watts is not a justified fix. Unix observation timestamps are intentional: Matter.js converts them to the Matter epoch when encoding the value.

There are [reports of different Apple Home presentation for bridged and standalone Matter devices](https://github.com/keremerkan/homebridge-shelly-matter/issues/13), and a [Homebridge report about watts appearing on one screen but not another](https://github.com/homebridge/homebridge/issues/3989). These are useful comparison cases, not proof of the cause of this plugin's blank cumulative values. Check the phone and active home hub OS versions as well as deployed logs before drawing that conclusion. A successful endpoint update still does not verify Apple Home receipt, cumulative kWh display, or history.

If both energy counters are confirmed locally while PV and temperature readings continue changing in Apple Home, investigate the energy reporting and presentation path. Preserve unfiltered Matter debug logs with subscription request paths, report messages, incoming status responses and replacement subscriptions. In Matter.js 0.17.9, `Subscription … reported invalid by peer` terminates that subscription and can mean either `InvalidSubscription` or generic `Failure`; the message alone does not identify which attributes were involved or establish why an energy tile is blank. See the [subscription error handler](https://github.com/matter-js/matter.js/blob/v0.17.9/packages/node/src/node/server/ServerSubscription.ts#L868). Existing local measurements can keep updating after a subscription closes.

Total Import Energy is a separate counter for energy bought from the grid. Register **79 is grid frequency**, so read 78–80 together but combine only words **78 and 80**. The two energy counters have distinct Matter accessory identities and must not overwrite each other. Do not add them together as a whole-home total. `--energy-only` reads **78–86** in one FC03 request and logs both counters in kWh. One live reading returned `totalConsumptionEnergy = 569.7` and `totalImportEnergy = 60.3`; compare with Total Load and Grid Buy on the inverter to confirm scope.

PV is a single total instantaneous DC power measurement, separate from cumulative kWh counters. The single-phase CLI logs only `pvTotalPowerW`, the sum of reported watts from registers 186 and 187. It does not read or expose separate PV input voltages, currents or powers. Zero is valid, including at night. If either input's power is invalid/unavailable, the total is `null`, not a partial sum. The raw register pair remains available for diagnostics under `raw.pvTotalPowerW`.

The plugin exposes one read-only **PV** Matter ElectricalSensor accessory in DC mode, using mW internally. Cached PV1/PV2 accessories from an earlier version are removed after the total PV endpoint is ready. The user's Apple Home Power screenshot confirms a 3 W reading; cumulative energy display remains unverified. No fake switch or cumulative-energy value is used to represent instantaneous power. Three-phase CLI profiles and the explicit `--grid-only`/`--energy-only` modes omit this single-phase PV reading.

## CLI checks on the real inverter

Use the CLI to compare register values with the inverter display. It does not start Homebridge, advertise Matter, or pair with Apple Home. It uses `.env` based on `.env.example`; Homebridge uses its platform settings instead.

```sh
npm start -- --once
npm start -- --energy-only --once
npm start -- --grid-only --once
```

Omit `--once` for continuous foreground logging and stop with **Ctrl+C**. To save all readings in PowerShell:

```powershell
npm start | Tee-Object -FilePath .local/deye.log -Append
```

To save only energy readings:

```powershell
npm start -- --energy-only | Tee-Object -FilePath .local/energy.log
```

The single-phase output includes temperatures, Grid voltage and contact state, `batteryPercent`, `totalConsumptionEnergy`, `totalImportEnergy`, `energyUnit` (kWh), raw words, register addresses, and grouped Modbus request ranges. `--energy-only` is supported only for the single-phase profile and cannot be combined with `--grid-only`. Three-phase CLI profiles omit energy and require an explicit model-appropriate `GRID_REGISTER` for Grid.

After building, the compiled CLI can be run with `npm run serve -- --once`.

## Development and automated checks

```sh
npm ci
npm run typecheck
npm test
npm run test:matter
npm pack
```

Unit tests use a simulated logger to verify decoding, Matter sensor registration, temperature units, Grid hysteresis, fault recovery, HAP migration and shutdown. Energy tests also verify independent meter state, delayed update confirmation, rejected updates, and real Homebridge behavior composition and Matter TLV encoding without starting a bridge. The encoding tests cover mWh, Unix-to-Matter timestamp conversion, unavailable values and zero; they do not test controller subscriptions or Apple Home rendering. `test:matter` uses an isolated Homebridge with seven real Matter endpoints, a simulated Matter network and a loopback Modbus logger. It verifies persisted values, measurement events and restoration after restart, without opening Matter UDP sockets or advertising on the LAN. Automated tests do not access the real inverter or pair with Apple Home. There is one Matter integration test suite; the old HAP integration test has been removed.

`npm pack` builds the plugin and creates `homebridge-deye-inverter-1.0.3.tgz`.


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
