import * as cheerio from 'cheerio'

const REMOVE_SELECTORS = [
  // Scripts & embeds
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  // Structural noise
  'nav',
  'footer',
  'header:not(article header)',
  'aside',
  'form',
  // ARIA roles
  '[role="banner"]',
  '[role="navigation"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  // Class-based noise
  '[class*="sidebar" i]',
  '[class*="cookie" i]',
  '[class*="consent" i]',
  '[class*="popup" i]',
  '[class*="modal" i]',
  '[class*="newsletter" i]',
  '[class*="subscribe" i]',
  '[class*="cookie-banner" i]',
  '[class*="chat-widget" i]',
  '[class*="social-share" i]',
  '[class*="breadcrumb" i]',
  '[class*="pagination" i]',
  // ID-based noise
  '[id*="cookie" i]',
  '[id*="consent" i]',
  '[id*="popup" i]',
  '[id*="modal" i]',
  '[id*="chat-widget" i]',
  // Ads
  '[class*="ad-" i]',
  '[class*="ads-" i]',
  '[class*="advert" i]',
  '[id*="ad-" i]',
  '[id*="ads-" i]',
  '[data-ad]',
  '[data-advertisement]',
  '[data-testid*="ad" i]',
]

export function sanitizeHtml(html: string): string {
  const $ = cheerio.load(html)

  for (const sel of REMOVE_SELECTORS) {
    $(sel).remove()
  }

  // Remove hidden elements
  $(
    '[style*="display:none"], [style*="display: none"], ' +
    '[style*="visibility:hidden"], [style*="visibility: hidden"], ' +
    '[style*="opacity:0"], [style*="opacity: 0"], ' +
    '[hidden], [aria-hidden="true"]'
  ).remove()

  // Remove images without descriptive alt text (keep those with meaningful alt)
  $('img').each((_, el) => {
    const alt = $(el).attr('alt')?.trim() ?? ''
    // Remove if no alt, or generic alt like "logo", "icon", "image", single word
    if (!alt || alt.length < 10 || /^(logo|icon|image|photo|img|banner|hero|placeholder)$/i.test(alt)) {
      $(el).remove()
    }
  })

  // Remove comments
  $('*')
    .contents()
    .filter(function () {
      return this.type === 'comment'
    })
    .remove()

  return $.html()
}
