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
      error: `Platform ${platform} requires residential proxy — WEBSHARE_API_TOKEN not configured`,
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

type Platform = 'youtube' | 'twitch' | 'instagram' | 'tiktok'

function detectPlatform(url: string): Platform | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host.includes('youtube.com')) return 'youtube'
    if (host.includes('twitch.tv')) return 'twitch'
    if (host.includes('instagram.com')) return 'instagram'
    if (host.includes('tiktok.com')) return 'tiktok'
  } catch { /* ignore */ }
  return null
}

/** Navigation timeout for platform pages (heavy SPAs) */
const PLATFORM_NAV_TIMEOUT = 60_000

/**
 * YouTube: Opens the "About" modal (channel description + links) and extracts
 * subscriber count, business email, social links, and description.
 *
 * The About modal is the ONLY reliable source for business emails and
 * external links on YouTube channels. Flow:
 *   1. Land on channel page → extract subscriber count
 *   2. Click "More about this channel" trigger (current YT layout uses
 *      the channel handle/name area or a dedicated "...more" button)
 *   3. Wait for the about modal (#description-container or the about panel)
 *   4. Extract all external links + description text
 */
async function handleYouTube(page: Page): Promise<string> {
  const parts: string[] = []

  try {
    // ── 1. Subscriber count (visible on channel header before any clicks) ──
    const subCount = await page.evaluate(() => {
      // Primary: #subscriber-count in channel header
      const el = document.querySelector('#subscriber-count') as HTMLElement | null
      if (el?.innerText?.trim()) return el.innerText.trim()
      // Fallback: yt-formatted-string containing "subscriber"
      for (const node of document.querySelectorAll('yt-formatted-string')) {
        const text = (node as HTMLElement).innerText?.trim() ?? ''
        if (/subscribers?$/i.test(text)) return text
      }
      return ''
    }).catch(() => '')
    if (subCount) parts.push(`Subscribers: ${subCount}`)

    // ── 2. Open the About modal / section ──
    // YouTube 2024-2026 layout: clicking "...more" or the channel description
    // area opens a modal overlay with #description-container showing links.
    const aboutTriggers = [
      // New layout: "...more" button under channel description snippet
      '#channel-header-content yt-formatted-string#description-text',
      'button#description-expand-button',
      'tp-yt-paper-button#expand',
      // About tab link (older layout, still works on some channels)
      '#tabsContent yt-tab-shape[tab-title="About"]',
      '#tabsContent a[href*="/about"]',
      'tp-yt-paper-tab:has-text("About")',
      // "More about this channel" text trigger
      'button:has-text("more about this channel")',
      'yt-button-shape:has-text("more")',
      // Channel name click (sometimes opens about)
      '#channel-header ytd-channel-name a',
    ]

    let modalOpened = false
    for (const sel of aboutTriggers) {
      try {
        const el = await page.$(sel)
        if (el && await el.isVisible()) {
          console.log(`[youtube-handler] Clicking about trigger: ${sel}`)
          await el.click()
          // Wait for the about container/modal to appear
          await page.waitForSelector(
            '#description-container, #about-container, ytd-about-channel-renderer, [page-subtype="about"]',
            { state: 'visible', timeout: 5000 }
          ).catch(() => {})
          await page.waitForTimeout(1500)
          modalOpened = true
          break
        }
      } catch { /* try next selector */ }
    }

    console.log(`[youtube-handler] Modal opened: ${modalOpened}`)

    // ── 3. Extract all external links from the about/links section ──
    const links = await page.evaluate(() => {
      const result: string[] = []
      const seen = new Set<string>()

      // All link containers YouTube uses for channel links
      const linkSelectors = [
        '#link-list-container a',
        '#links-section a',
        '#primary-links a',
        '#secondary-links a',
        'ytd-channel-external-link-view-model a',
        '[id*="channel-links"] a',
        '#about-container a',
        '#description-container a',
        'ytd-about-channel-renderer a',
      ]

      for (const sel of linkSelectors) {
        document.querySelectorAll(sel).forEach(a => {
          const anchor = a as HTMLAnchorElement
          let href = anchor.href
          // YouTube redirects external links through redirect URLs
          if (href.includes('youtube.com/redirect') || href.includes('google.com/url')) {
            try {
              const redirectUrl = new URL(href)
              href = redirectUrl.searchParams.get('q') || redirectUrl.searchParams.get('url') || href
            } catch { /* keep original */ }
          }
          const text = (a as HTMLElement).innerText?.trim()
          // Only external links (not youtube.com internal)
          if (href && !href.includes('youtube.com') && !href.includes('google.com/') && text && !seen.has(href)) {
            seen.add(href)
            result.push(`${text}: ${href}`)
          }
        })
      }
      return result
    }).catch(() => [] as string[])

    if (links.length > 0) {
      parts.push('Links:')
      parts.push(...links)
    }

    // ── 4. Extract about/description text (business emails often here) ──
    const aboutText = await page.evaluate(() => {
      const containers = [
        '#description-container',
        '#about-container',
        'ytd-about-channel-renderer',
        '#description',
        '#bio',
      ]
      for (const sel of containers) {
        const el = document.querySelector(sel) as HTMLElement | null
        if (el?.innerText && el.innerText.trim().length > 20) {
          return el.innerText.trim().slice(0, 3000)
        }
      }
      // Fallback: meta description
      const meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null
      return meta?.content?.slice(0, 500) ?? ''
    }).catch(() => '')
    if (aboutText) parts.push(`About: ${aboutText}`)

    // ── 5. Extract channel tagline / short description ──
    const tagline = await page.evaluate(() => {
      const el = document.querySelector('#channel-tagline, #channel-header-content #description-text') as HTMLElement | null
      return el?.innerText?.trim()?.slice(0, 300) ?? ''
    }).catch(() => '')
    if (tagline && !aboutText.includes(tagline)) parts.push(`Tagline: ${tagline}`)

    // ── 6. Extract recent video descriptions (business emails often here) ──
    try {
      const videoTabSelectors = [
        'yt-tab-shape[tab-title="Videos"]',
        'a[href*="/videos"]',
        'tp-yt-paper-tab:has-text("Videos")',
      ]

      let videosTabClicked = false
      for (const sel of videoTabSelectors) {
        try {
          const el = await page.$(sel)
          if (el && await el.isVisible()) {
            await el.click()
            await page.waitForTimeout(2000)
            videosTabClicked = true
            console.log(`[youtube-handler] Clicked Videos tab: ${sel}`)
            break
          }
        } catch { /* try next */ }
      }

      if (videosTabClicked) {
        // Get first 3 video URLs
        const videoUrls = await page.evaluate(() => {
          const links: string[] = []
          const seen = new Set<string>()
          const selectors = ['a#video-title-link', 'a#video-title']
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach(a => {
              const href = (a as HTMLAnchorElement).href
              if (href && href.includes('/watch') && !seen.has(href) && links.length < 3) {
                seen.add(href)
                links.push(href)
              }
            })
          }
          return links
        }).catch(() => [] as string[])

        if (videoUrls.length > 0) {
          const videoDescriptions: string[] = []
          const context = page.context()

          for (const videoUrl of videoUrls.slice(0, 3)) {
            let videoPage: Page | null = null
            try {
              videoPage = await context.newPage()
              await videoPage.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
              await videoPage.waitForTimeout(2000)

              // Click expand button to show full description
              const expandBtn = await videoPage.$('#expand')
              if (expandBtn && await expandBtn.isVisible()) {
                await expandBtn.click()
                await videoPage.waitForTimeout(1000)
              }

              // Extract description text
              const desc = await videoPage.evaluate(() => {
                const containers = ['#description-inner', 'ytd-text-inline-expander']
                for (const sel of containers) {
                  const el = document.querySelector(sel) as HTMLElement | null
                  if (el?.innerText && el.innerText.trim().length > 20) {
                    return el.innerText.trim().slice(0, 2000)
                  }
                }
                return ''
              }).catch(() => '')

              if (desc) videoDescriptions.push(desc)
            } catch {
              // Video page failed, continue
            } finally {
              if (videoPage) await videoPage.close()
            }
          }

          if (videoDescriptions.length > 0) {
            parts.push('Recent Video Descriptions:')
            videoDescriptions.forEach((d, i) => parts.push(`  Video ${i + 1}: ${d}`))
            console.log(`[youtube-handler] Extracted ${videoDescriptions.length} video description(s)`)
          }
        }
      }
    } catch (err) {
      console.log(`[youtube-handler] Video descriptions extraction failed: ${err instanceof Error ? err.message : err}`)
    }

  } catch (err) {
    console.log(`[youtube-handler] Error: ${err instanceof Error ? err.message : err}`)
  }

  return parts.length > 0 ? `\n\n--- YOUTUBE CHANNEL DATA ---\n${parts.join('\n')}` : ''
}

/**
 * Twitch: Full SPA handling with extended timeouts.
 * Dismisses cookie/consent wall, waits for React hydration,
 * extracts follower count, channel bio, and social links from panels.
 */
async function handleTwitch(page: Page): Promise<string> {
  const parts: string[] = []

  try {
    // ── 1. Dismiss cookie consent (Twitch-specific + generic) ──
    const twitchConsentSelectors = [
      'button[data-a-target="consent-banner-accept"]',
      '[data-a-target="consent-banner"] button:first-of-type',
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'button:has-text("Agree")',
    ]

    for (const sel of twitchConsentSelectors) {
      try {
        const el = await page.$(sel)
        if (el && await el.isVisible()) {
          await el.click()
          console.log(`[twitch-handler] Dismissed consent: ${sel}`)
          await page.waitForTimeout(1500)
          break
        }
      } catch { /* try next */ }
    }

    // ── 2. Wait for page hydration (Twitch is a heavy React SPA) ──
    // Wait for any of these indicators that the page has loaded
    await page.waitForSelector(
      '[data-a-target="followers-count"], ' +
      '[data-a-target="channel-viewers-count"], ' +
      '.channel-info-content, ' +
      '[class*="ChannelInfoBar"], ' +
      'h1[data-a-target="stream-title"]',
      { timeout: 17_000 }
    ).catch(() => {
      console.log('[twitch-handler] Timeout waiting for page hydration, extracting what we can')
    })

    // Extra settle for React renders
    await page.waitForTimeout(3000)

    // ── 3. Click "About" panel if available ──
    const aboutSelectors = [
      '[data-a-target="about-panel-button"]',
      'button:has-text("About")',
      'a[href*="/about"]',
    ]
    for (const sel of aboutSelectors) {
      try {
        const el = await page.$(sel)
        if (el && await el.isVisible()) {
          await el.click()
          await page.waitForTimeout(2000)
          console.log(`[twitch-handler] Clicked About: ${sel}`)
          break
        }
      } catch { /* next */ }
    }

    // ── 4. Extract follower count ──
    const followers = await page.evaluate(() => {
      const selectors = [
        '[data-a-target="followers-count"]',
        '.tw-stat__value',
        '[class*="followers"]',
      ]
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null
        if (el?.innerText) return el.innerText.trim()
      }
      // Fallback: regex from full page text
      const body = document.body.innerText
      const match = body.match(/([\d,.]+[KkMm]?)\s*(?:followers?)/i)
      return match ? match[0] : ''
    }).catch(() => '')
    if (followers) parts.push(`Followers: ${followers}`)

    // ── 5. Extract channel bio/about text ──
    const bio = await page.evaluate(() => {
      const containers = [
        '[data-a-target="profile-panel"]',
        '.about-section',
        '.channel-info-content',
        '[class*="AboutPanel"]',
        '[class*="about"]',
      ]
      const texts: string[] = []
      for (const sel of containers) {
        document.querySelectorAll(sel).forEach(el => {
          const text = (el as HTMLElement).innerText?.trim()
          if (text && text.length > 10) texts.push(text)
        })
      }
      return texts.join('\n').slice(0, 2000)
    }).catch(() => '')
    if (bio) parts.push(`Bio: ${bio}`)

    // ── 6. Extract social/external links from panels ──
    const socialLinks = await page.evaluate(() => {
      const result: string[] = []
      const seen = new Set<string>()
      // Twitch social links panel
      document.querySelectorAll(
        '[data-a-target="social-media-link"] a, ' +
        '.social-media-link a, ' +
        '.channel-panels a, ' +
        '[class*="panel"] a'
      ).forEach(a => {
        const href = (a as HTMLAnchorElement).href
        const text = (a as HTMLElement).innerText?.trim()
        if (href && !href.includes('twitch.tv') && !seen.has(href)) {
          seen.add(href)
          result.push(text ? `${text}: ${href}` : href)
        }
      })
      return result
    }).catch(() => [] as string[])
    if (socialLinks.length > 0) {
      parts.push('Social links:')
      parts.push(...socialLinks)
    }

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

    // Platform pages (YouTube, Twitch) are heavy SPAs — use longer timeouts
    const navTimeout = platform ? PLATFORM_NAV_TIMEOUT : 20_000
    const fallbackTimeout = platform ? 30_000 : 15_000

    // Try networkidle first (catches SPA content), fall back to domcontentloaded
    let response = await page
      .goto(url, { waitUntil: 'networkidle', timeout: navTimeout })
      .catch(async () => {
        // networkidle timed out (common on heavy sites), retry with domcontentloaded
        return page.goto(url, { waitUntil: 'domcontentloaded', timeout: fallbackTimeout })
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
