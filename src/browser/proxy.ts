type ProxyConfig = {
  server: string
  username: string
  password: string
}

// ─── Webshare Residential Proxy (backbone gateway) ────────────────────────
// Each port = unique residential exit IP. Rotating port = rotating IP.
// Gateway: p.webshare.io, ports 10000–215083
// Auth: username-N:password (N = port index)

const API_TOKEN = process.env.WEBSHARE_API_TOKEN ?? ''
const GATEWAY_HOST = 'p.webshare.io'
const BASE_USERNAME = 'gvkxttgp'
const PASSWORD = '88423gzol7fh'
const PORT_MIN = 10000
const PORT_MAX = 215083
const POOL_SIZE = PORT_MAX - PORT_MIN + 1

let lastUsedPort = PORT_MIN - 1

export function buildProxy(): ProxyConfig {
  // Round-robin through ports for IP rotation
  lastUsedPort = lastUsedPort >= PORT_MAX ? PORT_MIN : lastUsedPort + 1
  const portIndex = lastUsedPort - PORT_MIN + 1

  return {
    server: `http://${GATEWAY_HOST}:${lastUsedPort}`,
    username: `${BASE_USERNAME}-${portIndex}`,
    password: PASSWORD,
  }
}

export function isProxyConfigured(): boolean {
  return API_TOKEN.length > 0
}

export function getPoolSize(): number {
  return isProxyConfigured() ? POOL_SIZE : 0
}
