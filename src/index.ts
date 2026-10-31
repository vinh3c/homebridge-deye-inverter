import type { API } from 'homebridge';
import { DeyePlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform.js';

export default (api: API) => {
  console.info(`[${PLUGIN_NAME}] Plugin loaded (Homebridge ${api.serverVersion}, Node ${process.version}). Registering ${PLATFORM_NAME}.`);
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DeyePlatform);
  api.on('didFinishLaunching', () => {
    if (!DeyePlatform.isInitialized(api)) {
      console.warn(`[${PLUGIN_NAME}] Plugin loaded, but ${PLATFORM_NAME} was not initialized in this process. Check child bridge logs if enabled; otherwise add { "platform": "${PLATFORM_NAME}", "host": "192.168.5.60" } to config.json platforms and restart Homebridge.`);
    }
  });
};
