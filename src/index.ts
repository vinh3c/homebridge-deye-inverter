import type { API } from 'homebridge';
import { DeyePlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform.js';

export default (api: API) => {
  console.info(`[${PLUGIN_NAME}] Plugin loaded (Homebridge ${api.serverVersion}, Node ${process.version}). Registering ${PLATFORM_NAME}.`);
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DeyePlatform);
  api.on('didFinishLaunching', () => {
    if (!DeyePlatform.isInitialized(api)) {
      console.warn(`[${PLUGIN_NAME}] SETUP REQUIRED: plugin installed, but no ${PLATFORM_NAME} platform is running in this process.`);
      console.warn(`[${PLUGIN_NAME}] Open Homebridge UI > Plugins > Deye Inverter > Plugin Config. Enter your logger IP address, click Save, then Restart Homebridge. No manual JSON editing is needed.`);
      console.warn(`[${PLUGIN_NAME}] Enable Modbus in your logger first. If you already configured a child bridge, check that child bridge's logs and restart it.`);
    }
  });
};
