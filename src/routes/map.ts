import { Router } from 'express'
import { MapRequestSchema, type MapResponse } from '../types'
import { createContext, releaseContext } from '../browser/pool'

const router = Router()

router.post('/map', async (req, res) => {
  const parsed = MapRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      url: req.body?.url ?? '',
      links: [],
      error: parsed.error.message,
    } satisfies MapResponse)
  }

  const { url } = parsed.data
  const context = await createContext()

  try {
    const page = await context.newPage()
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 }).catch(async () => {
        return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      })
      await page.waitForTimeout(2000)

      const baseUrl = new URL(url)

      const links = await page.evaluate((origin: string) => {
        const anchors = document.querySelectorAll('a[href]')
        const hrefs: string[] = []
        const seen = new Set<string>()

        anchors.forEach((a) => {
          try {
            const href = (a as HTMLAnchorElement).href
            const u = new URL(href)
            // Only same-origin links
            if (u.origin !== origin) return
            // Skip fragments, javascript:, mailto:, tel:
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return
            const normalized = u.origin + u.pathname.replace(/\/+$/, '')
            if (!seen.has(normalized)) {
              seen.add(normalized)
              hrefs.push(normalized)
            }
          } catch {
            // Invalid URL
          }
        })

        return hrefs
      }, baseUrl.origin)

      res.json({
        success: true,
        url,
        links,
      } satisfies MapResponse)
    } finally {
      await page.close()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[map] Failed: ${url}`, message)
    res.status(500).json({
      success: false,
      url,
      links: [],
      error: message,
    } satisfies MapResponse)
  } finally {
    releaseContext(context)
  }
})

export default router
