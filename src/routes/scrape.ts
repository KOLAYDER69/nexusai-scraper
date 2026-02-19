import { Router } from 'express'
import type { BrowserContext, Page } from 'playwright'
import { ScrapeRequestSchema, type ScrapeResponse } from '../types'
import { createContext, releaseContext, isProxyActive } from '../browser/pool'
import { sanitizeHtml } from '../transform/sanitize'
import { extractMainContent } from '../transform/extract'
import { htmlToMarkdown, applyTokenGuard } from '../transform/markdown'
import { extractMetadata, extractTitle } from '../transform/metadata'
import { dismissConsentBanners } from '../utils/consent'
import { withRetry } from '../utils/retry'
import { isProxyConfigured } from '../browser/proxy'

const router = Router()

// Sub-page paths to auto-scrape when main page lacks contact info
const CONTACT_SUB_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/team', '/management', '/impressum']
const CONTACT_KEYWORDS = /email|phone|tel:|mailto:|@[\w.-]+\.\w{2,}|\+?\d[\d\s\-().]{6,}/i

router.post('/scrape', async (req, res) => {
  const parsed = ScrapeRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      url: req.body?.url ?? '',
      title: '',
      markdown: '',
      metadata: {},
      status: 400,
      error: parsed.error.message,
    } satisfies ScrapeResponse)
  }

  const { url, waitFor, onlyMainContent, autoMap, includeRawText } = parsed.data
  const platform = detectPlatform(url)

  // Guard: skip platform scraping if no proxy configured (will get blocked)
  if (platform && !isProxyActive()) {
    console.log(`[PROXY_GUARD] Skipping ${platform} scrape for ${url} — no residential proxy configured`)
    return res.json({
      success: false,
      url,
      title: '',
      markdown: '',
      metadata: {},
      status: 403,
      error: `Platform ${platform} requires residential proxy — BRIGHT_DATA credentials not configured`,
    } satisfies ScrapeResponse)
  }

  try {
    const result = await withRetry(
      async (attempt) => {
        const context = await createContext()
        try {
          // On retry, force a fresh proxy session (new residential IP)
          if (attempt > 0 && isProxyConfigured()) {
            console.log(`[PROXY_ROTATE] Attempt ${attempt + 1}: rotating to new residential IP for ${url}`)
            releaseContext(context)
            const retryContext = await createContext()
            try {
              return await scrapeWithAutoMap(retryContext, url, waitFor, onlyMainContent, autoMap, includeRawText)
            } finally {
              releaseContext(retryContext)
            }
          }
          return await scrapeWithAutoMap(context, url, waitFor, onlyMainContent, autoMap, includeRawText)
        } finally {
          releaseContext(context)
        }
      },
      {
        maxRetries: 3,
        onRetry: (attempt, err) => {
          const status = (err as { status?: number }).status
          console.log(`[scrape] Retry ${attempt} for ${url} (status=${status ?? '?'}) — ${isProxyActive() ? 'rotating proxy session' : 'WARNING: no proxy to rotate'}`)
        },
      }
    )

    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[scrape] Failed: ${url}`, message)
    res.status(500).json({
      success: false,
      url,
      title: '',
      markdown: '',
      metadata: {},
      status: 500,
      error: message,
    } satisfies ScrapeResponse)
  }
})

async function scrapeWithAutoMap(
  context: BrowserContext,
  url: string,
  waitFor: number,
  onlyMainContent: boolean,
  autoMap: boolean,
  includeRawText: boolean = false,
): Promise<ScrapeResponse> {
  // Scrape the main page
  const main = await scrapePage(context, url, waitFor, onlyMainContent, includeRawText)
  if (!main.success) return main

  // If autoMap disabled or main page already has contact info, return as-is
  if (!autoMap || CONTACT_KEYWORDS.test(main.markdown)) {
    const guarded = applyTokenGuard(main.markdown)
    return { ...main, markdown: guarded.markdown, truncated: guarded.truncated }
  }

  // Intelligent crawl: main page lacks contact info, scrape sub-pages
  const baseUrl = new URL(url)
  const base = `${baseUrl.protocol}//${baseUrl.host}`

  // Find which sub-pages exist by extracting links from the main page
  const page = await context.newPage()
  let subLinks: string[] = []
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    subLinks = await page.evaluate(
      (args: { origin: string; paths: string[] }) => {
        const anchors = document.querySelectorAll('a[href]')
        const found: string[] = []
        const pathSet = new Set(args.paths)
        anchors.forEach((a) => {
          try {
            const u = new URL((a as HTMLAnchorElement).href)
            if (u.origin !== args.origin) return
            const path = u.pathname.replace(/\/+$/, '').toLowerCase()
            if (pathSet.has(path) && !found.includes(u.href)) {
              found.push(u.origin + u.pathname)
            }
          } catch { /* skip */ }
        })
        return found
      },
      { origin: baseUrl.origin, paths: CONTACT_SUB_PATHS }
    )
  } catch {
    // Fallback: try known paths directly
    subLinks = CONTACT_SUB_PATHS.slice(0, 3).map((p) => `${base}${p}`)
  } finally {
    await page.close()
  }

  // Scrape top 3 sub-pages
  const subPagesToScrape = subLinks.slice(0, 3)
  const subResults: string[] = []
  const scrapedSubPages: string[] = []

  for (const subUrl of subPagesToScrape) {
    try {
      const sub = await scrapePage(context, subUrl, Math.min(waitFor, 2000), onlyMainContent)
      if (sub.success && sub.markdown.length > 50) {
        subResults.push(`\n\n---\n\n## ${sub.title || subUrl}\n\n${sub.markdown}`)
        scrapedSubPages.push(subUrl)
      }
    } catch {
      // Sub-page failed, continue
    }
  }

  const combined = main.markdown + subResults.join('')
  const guarded = applyTokenGuard(combined)

  return {
    ...main,
    markdown: guarded.markdown,
    truncated: guarded.truncated,
    subPages: scrapedSubPages.length > 0 ? scrapedSubPages : undefined,
  }
}

// ─── Platform-specific Playwright handlers ────────────────────────────────

function detectPlatform(url: string): 'youtube' | 'twitch' | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host.includes('youtube.com')) return 'youtube'
    if (host.includes('twitch.tv')) return 'twitch'
  } catch { /* ignore */ }
  return null
}

/**
 * YouTube: Click "more info" / about section to reveal channel links and description.
 * Extracts subscriber count + links section from DOM before sanitization strips them.
 */
async function handleYouTube(page: Page): Promise<string> {
  const parts: string[] = []

  try {
    // Extract subscriber count from channel header
    const subCount = await page.evaluate(() => {
      // ytd-c4-tabbed-header-renderer #subscriber-count, or yt-formatted-string near "subscribers"
      const el = document.querySelector('#subscriber-count') as HTMLElement | null
      return el?.innerText?.trim() ?? ''
    }).catch(() => '')
    if (subCount) parts.push(`Subscribers: ${subCount}`)

    // Try clicking "More about this channel" or the about tab
    const aboutSelectors = [
      'tp-yt-paper-tab:has-text("About")',           // About tab (old layout)
      '#tabsContent a[href*="/about"]',               // About tab link
      'button:has-text("more about this channel")',   // Modal trigger
      '#description-container .more-button',          // Expand description
      'tp-yt-paper-button#expand',                    // Expand button
    ]

    for (const sel of aboutSelectors) {
      try {
        const el = await page.$(sel)
        if (el && await el.isVisible()) {
          await el.click()
          await page.waitForTimeout(1500)
          break
        }
      } catch { /* try next */ }
    }

    // Extract all links from the about section / channel links panel
    const links = await page.evaluate(() => {
      const result: string[] = []
      // Channel links section (new layout)
      document.querySelectorAll('#link-list-container a, #links-section a, [id*="channel-links"] a').forEach(a => {
        const href = (a as HTMLAnchorElement).href
        const text = (a as HTMLElement).innerText?.trim()
        if (href && !href.includes('youtube.com') && text) {
          result.push(`${text}: ${href}`)
        }
      })
      // About section text
      const aboutEl = document.querySelector('#about-container, #description-container, [id*="about"]') as HTMLElement | null
      if (aboutEl?.innerText) {
        result.push(`About: ${aboutEl.innerText.slice(0, 2000)}`)
      }
      return result
    }).catch(() => [] as string[])

    parts.push(...links)

    // Extract channel description
    const description = await page.evaluate(() => {
      const el = document.querySelector('#channel-tagline, #channel-description, meta[name="description"]') as HTMLElement | null
      if (el instanceof HTMLMetaElement) return el.content?.slice(0, 500) ?? ''
      return el?.innerText?.slice(0, 500) ?? ''
    }).catch(() => '')
    if (description) parts.push(`Description: ${description}`)

  } catch (err) {
    console.log(`[youtube-handler] Error: ${err instanceof Error ? err.message : err}`)
  }

  return parts.length > 0 ? `\n\n--- YOUTUBE CHANNEL DATA ---\n${parts.join('\n')}` : ''
}

/**
 * Twitch: Dismiss cookie wall, wait for follower count metadata to render.
 * Extracts follower count and channel bio from rendered DOM.
 */
async function handleTwitch(page: Page): Promise<string> {
  const parts: string[] = []

  try {
    // Twitch cookie consent wall — more aggressive than generic consent
    const twitchConsentSelectors = [
      'button[data-a-target="consent-banner-accept"]',
      '[data-a-target="consent-banner"] button:first-of-type',
      'button:has-text("Accept")',
    ]

    for (const sel of twitchConsentSelectors) {
      try {
        const el = await page.$(sel)
        if (el && await el.isVisible()) {
          await el.click()
          await page.waitForTimeout(1000)
          break
        }
      } catch { /* try next */ }
    }

    // Wait for follower count to render (JS-heavy SPA)
    await page.waitForSelector('[data-a-target="followers-count"], .tw-stat, [class*="ChannelInfoBar"]', {
      timeout: 8000,
    }).catch(() => {})

    // Extract follower count
    const followers = await page.evaluate(() => {
      // Try multiple known selectors for follower count
      const selectors = [
        '[data-a-target="followers-count"]',
        '.tw-stat__value',
        '[class*="followers"]',
      ]
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null
        if (el?.innerText) return el.innerText.trim()
      }
      // Fallback: find text matching "X followers" pattern
      const body = document.body.innerText
      const match = body.match(/([\d,.]+[KkMm]?)\s*(?:followers?)/i)
      return match ? match[0] : ''
    }).catch(() => '')
    if (followers) parts.push(`Followers: ${followers}`)

    // Extract channel bio/about
    const bio = await page.evaluate(() => {
      const panels = document.querySelectorAll('[class*="about"], [data-a-target="profile-panel"], .channel-info-content')
      const texts: string[] = []
      panels.forEach(el => {
        const text = (el as HTMLElement).innerText?.trim()
        if (text && text.length > 10) texts.push(text)
      })
      return texts.join('\n').slice(0, 1500)
    }).catch(() => '')
    if (bio) parts.push(`Bio: ${bio}`)

  } catch (err) {
    console.log(`[twitch-handler] Error: ${err instanceof Error ? err.message : err}`)
  }

  return parts.length > 0 ? `\n\n--- TWITCH CHANNEL DATA ---\n${parts.join('\n')}` : ''
}

// ─── Core scrape function ─────────────────────────────────────────────────

async function scrapePage(
  context: BrowserContext,
  url: string,
  waitFor: number,
  onlyMainContent: boolean,
  includeRawText: boolean = false,
): Promise<ScrapeResponse> {
  const page = await context.newPage()
  const platform = detectPlatform(url)

  try {
    console.log(`[SCRAPE_START] url=${url} platform=${platform ?? 'generic'}`)

    // Try networkidle first (catches SPA content), fall back to domcontentloaded
    let response = await page
      .goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
      .catch(async () => {
        // networkidle timed out (common on heavy sites), retry with domcontentloaded
        return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      })

    const status = response?.status() ?? 0
    console.log(`[PAGE_STATUS] url=${url} status=${status} title="${await page.title().catch(() => '?')}"`)
    if (status >= 400) {
      throw Object.assign(new Error(`HTTP ${status}`), { status })
    }

    // Additional settle time for JS-rendered content
    await page.waitForTimeout(waitFor)

    // Dismiss cookie banners
    await dismissConsentBanners(page)

    // Platform-specific DOM interactions
    let platformData = ''
    if (platform === 'youtube') {
      platformData = await handleYouTube(page)
    } else if (platform === 'twitch') {
      platformData = await handleTwitch(page)
    }

    // Extract raw visible text BEFORE sanitization (preserves sidebar/nav data)
    let rawText: string | undefined
    if (includeRawText) {
      try {
        rawText = await page.evaluate(() => document.body.innerText)
        if (rawText) rawText = rawText.slice(0, 8000)
        // Append platform-specific extracted data to raw text
        if (platformData) rawText = (rawText ?? '') + platformData
      } catch {
        // Raw text extraction failed, continue without it
      }
    }

    const rawHtml = await page.content()
    const title = extractTitle(rawHtml)
    const metadata = extractMetadata(rawHtml)
    const sanitized = sanitizeHtml(rawHtml)
    const mainContent = extractMainContent(sanitized, onlyMainContent)
    let markdown = htmlToMarkdown(mainContent)

    // Append platform data to markdown as well (it won't survive sanitization)
    if (platformData) markdown += platformData

    console.log(`[CONTENT_STATS] url=${url} rawHtml=${rawHtml.length}b markdown=${markdown.length}b rawText=${rawText?.length ?? 0}b platform=${platform ?? 'none'}`)

    return {
      success: true,
      url,
      title,
      markdown,
      metadata,
      status,
      ...(rawText ? { rawText } : {}),
    }
  } finally {
    await page.close()
  }
}

export default router
