// src/index.ts
// Hydra - Multiplex HTTP Proxy using Effection

// Types
export type {
  ServerInfo,
  ServerPool,
  ServerEvent,
  SwitchboardConfig,
  AppServerConfig,
} from './types';

// Server Resource
export {
  useExpressServer,
  useExpressServerDaemon,
  ServerDaemonError,
  type ExpressServerHandle,
} from './server-resource';

// Server Pool
export {
  useServerPool,
  ServerPoolContext,
  type ServerPoolConfig,
} from './server-pool';

// Switchboard
export {
  useSwitchboard,
  type SwitchboardHandle,
} from './switchboard';
