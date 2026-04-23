import { ProxyServerConfig } from "@/types/index.js";

export const DEFAULT_PROXY_CONFIG: ProxyServerConfig = {
  port: 8080,
  host: "0.0.0.0",
  baseDomain: "dployr.io",
  timeoutMs: 30000,
};