import type { API } from 'homebridge';
import { DeyePlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform.js';

export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DeyePlatform);
};
