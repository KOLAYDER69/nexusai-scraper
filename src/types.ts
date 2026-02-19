import { z } from 'zod'

export const ScrapeRequestSchema = z.object({
  url: z.string().url(),
  waitFor: z.number().optional().default(3000),
  onlyMainContent: z.boolean().optional().default(true),
  autoMap: z.boolean().optional().default(false),
  includeRawText: z.boolean().optional().default(false),
})

export const MapRequestSchema = z.object({
  url: z.string().url(),
})

export type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>

export type ScrapeResponse = {
  success: boolean
  url: string
  title: string
  markdown: string
  metadata: PageMetadata
  status: number
  truncated?: boolean
  subPages?: string[]
  rawText?: string
  error?: string
}

export type MapRequest = z.infer<typeof MapRequestSchema>

export type MapResponse = {
  success: boolean
  url: string
  links: string[]
  error?: string
}

export type PageMetadata = {
  ogTitle?: string
  ogDescription?: string
  ogImage?: string
  ogType?: string
  canonical?: string
  language?: string
}
