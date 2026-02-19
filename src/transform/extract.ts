import * as cheerio from 'cheerio'

/**
 * Extract the most content-rich element from the page.
 * Priority: <main> > <article> > [role="main"] > highest text-density element > <body>
 */
export function extractMainContent(html: string, onlyMainContent: boolean): string {
  if (!onlyMainContent) return html

  const $ = cheerio.load(html)

  // Priority 1: <main>
  const main = $('main')
  if (main.length > 0) return main.html() ?? html

  // Priority 2: <article>
  const article = $('article')
  if (article.length > 0) {
    // If multiple articles, pick the longest
    let best = ''
    article.each((_, el) => {
      const content = $(el).html() ?? ''
      if (content.length > best.length) best = content
    })
    if (best.length > 0) return best
  }

  // Priority 3: [role="main"]
  const roleMain = $('[role="main"]')
  if (roleMain.length > 0) return roleMain.html() ?? html

  // Priority 4: highest text-density element
  const candidates = $('div, section').toArray()
  let bestEl: ReturnType<typeof candidates['at']> = undefined
  let bestDensity = 0

  for (const el of candidates) {
    const text = $(el).text().trim()
    const htmlLen = $(el).html()?.length ?? 0
    if (htmlLen === 0) continue
    const density = text.length / htmlLen
    // Only consider elements with substantial text
    if (text.length > 200 && density > bestDensity) {
      bestDensity = density
      bestEl = el
    }
  }

  if (bestEl) return $(bestEl).html() ?? html

  // Fallback: <body>
  return $('body').html() ?? html
}
