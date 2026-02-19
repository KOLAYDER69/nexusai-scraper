import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

let initialized = false

export function getStealthBrowser() {
  if (!initialized) {
    chromium.use(StealthPlugin())
    initialized = true
  }
  return chromium
}
