import type { Page } from 'playwright'

const CONSENT_SELECTORS = [
  // Common cookie consent buttons
  'button[id*="accept" i]',
  'button[id*="agree" i]',
  'button[id*="consent" i]',
  'button[class*="accept" i]',
  'button[class*="agree" i]',
  'button[class*="consent" i]',
  'a[id*="accept" i]',
  'a[class*="accept" i]',
  // GDPR-specific
  '[data-testid="cookie-accept"]',
  '[data-cookiebanner="accept_button"]',
  '#onetrust-accept-btn-handler',
  '.cc-accept',
  '.cc-btn.cc-allow',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#didomi-notice-agree-button',
  // Generic "OK" / "Got it" buttons in cookie banners
  '[class*="cookie"] button:first-of-type',
  '[id*="cookie"] button:first-of-type',
]

export async function dismissConsentBanners(page: Page): Promise<void> {
  for (const selector of CONSENT_SELECTORS) {
    try {
      const el = await page.$(selector)
      if (el && await el.isVisible()) {
        await el.click()
        await page.waitForTimeout(500)
        return
      }
    } catch {
      // Selector not found or click failed, try next
    }
  }
}
