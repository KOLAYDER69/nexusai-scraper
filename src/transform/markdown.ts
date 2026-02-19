import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

let service: TurndownService | null = null

function getService(): TurndownService {
  if (service) return service

  service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })

  // GFM: tables, strikethrough, task lists
  service.use(gfm)

  // Preserve mailto and tel links as-is
  service.addRule('mailto', {
    filter: (node) =>
      node.nodeName === 'A' &&
      (node.getAttribute('href')?.startsWith('mailto:') ?? false),
    replacement: (_content, node) => {
      const el = node as HTMLAnchorElement
      const href = el.getAttribute('href') ?? ''
      const text = el.textContent?.trim() ?? ''
      return `[${text}](${href})`
    },
  })

  service.addRule('tel', {
    filter: (node) =>
      node.nodeName === 'A' &&
      (node.getAttribute('href')?.startsWith('tel:') ?? false),
    replacement: (_content, node) => {
      const el = node as HTMLAnchorElement
      const href = el.getAttribute('href') ?? ''
      const text = el.textContent?.trim() ?? ''
      return `[${text}](${href})`
    },
  })

  // Remove empty links
  service.addRule('emptyLinks', {
    filter: (node) =>
      node.nodeName === 'A' && (node.textContent?.trim().length ?? 0) === 0,
    replacement: () => '',
  })

  // Images with descriptive alt text → keep as text reference (no URL to save tokens)
  service.addRule('descriptiveImages', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (node as HTMLImageElement).getAttribute('alt')?.trim() ?? ''
      if (alt.length >= 10) return `[Image: ${alt}]`
      return ''
    },
  })

  return service
}

export function htmlToMarkdown(html: string): string {
  const md = getService().turndown(html)
  // Collapse multiple blank lines into at most two
  return md.replace(/\n{3,}/g, '\n\n').trim()
}

// ~4 chars per token for English/mixed text
const CHARS_PER_TOKEN = 4
const MAX_TOKENS = 40_000
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN

export function applyTokenGuard(markdown: string): { markdown: string; truncated: boolean } {
  if (markdown.length <= MAX_CHARS) {
    return { markdown, truncated: false }
  }
  return {
    markdown: markdown.slice(0, MAX_CHARS) + '\n\n[Content Truncated for Optimization]',
    truncated: true,
  }
}
