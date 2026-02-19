import * as cheerio from 'cheerio'
import type { PageMetadata } from '../types'

export function extractMetadata(html: string): PageMetadata {
  const $ = cheerio.load(html)

  const meta = (name: string): string | undefined => {
    return (
      $(`meta[property="${name}"]`).attr('content') ??
      $(`meta[name="${name}"]`).attr('content') ??
      undefined
    )
  }

  return {
    ogTitle: meta('og:title'),
    ogDescription: meta('og:description') ?? meta('description'),
    ogImage: meta('og:image'),
    ogType: meta('og:type'),
    canonical: $('link[rel="canonical"]').attr('href') ?? undefined,
    language: $('html').attr('lang') ?? undefined,
  }
}

export function extractTitle(html: string): string {
  const $ = cheerio.load(html)
  return $('title').first().text().trim() || ''
}
