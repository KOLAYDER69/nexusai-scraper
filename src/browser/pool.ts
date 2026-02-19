import type { Browser, BrowserContext } from 'playwright'
import { getStealthBrowser } from './stealth'
import { buildProxy, isProxyConfigured, getPoolSize } from './proxy'
import { randomUserAgent, randomViewport } from '../utils/user-agent'

const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY ?? '5', 10)
const RECYCLE_AFTER_REQUESTS = 50
const RECYCLE_AFTER_MS = 5 * 60 * 1000

let browser: Browser | null = null
let requestCount = 0
let createdAt = 0
let activeContexts = 0

const BLOCKED_RESOURCE_TYPES = ['image', 'font', 'stylesheet', 'media']

async function ensureBrowser(): Promise<Browser> {
  const shouldRecycle =
    browser !== null &&
    (requestCount >= RECYCLE_AFTER_REQUESTS || Date.now() - createdAt >= RECYCLE_AFTER_MS)

  if (shouldRecycle && activeContexts === 0) {
    await browser!.close().catch(() => {})
    browser = null
  }

  if (!browser) {
    const stealthChromium = getStealthBrowser()
    browser = await stealthChromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })
    requestCount = 0
    createdAt = Date.now()
  }

  return browser
}

export async function createContext(): Promise<BrowserContext> {
  if (activeContexts >= MAX_CONCURRENCY) {
    throw Object.assign(new Error('Max concurrency reached'), { status: 429 })
  }

  const b = await ensureBrowser()
  requestCount++
  activeContexts++

  const useProxy = isProxyConfigured()
  const proxy = useProxy ? buildProxy() : undefined

  if (proxy) {
    console.log(`[PROXY] Webshare residential ${proxy.server} (${getPoolSize()} IPs available)`)
  } else {
    console.log(`[PROXY] WARNING: No proxy configured — using direct IP. Platform sites (YouTube, Twitch) will likely block.`)
  }

  const context = await b.newContext({
    userAgent: randomUserAgent(),
    viewport: randomViewport(),
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ...(proxy ? { proxy } : {}),
  })

  // Block heavy resources
  await context.route('**/*', (route) => {
    const type = route.request().resourceType()
    if (BLOCKED_RESOURCE_TYPES.includes(type)) {
      return route.abort()
    }
    return route.continue()
  })

  return context
}

export function isProxyActive(): boolean {
  return isProxyConfigured()
}

export function releaseContext(context: BrowserContext): void {
  activeContexts = Math.max(0, activeContexts - 1)
  context.close().catch(() => {})
}

export function poolStats() {
  return {
    browserAlive: browser !== null,
    activeContexts,
    totalRequests: requestCount,
    maxConcurrency: MAX_CONCURRENCY,
    uptimeMs: browser ? Date.now() - createdAt : 0,
  }
}

export async function shutdownPool(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {})
    browser = null
  }
}
