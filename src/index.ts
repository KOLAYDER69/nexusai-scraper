import express from 'express'
import scrapeRouter from './routes/scrape'
import mapRouter from './routes/map'
import healthRouter from './routes/health'
import { shutdownPool } from './browser/pool'

const app = express()
const PORT = parseInt(process.env.PORT ?? '3001', 10)

app.use(express.json())

app.use(scrapeRouter)
app.use(mapRouter)
app.use(healthRouter)

const server = app.listen(PORT, () => {
  console.log(`Scraper service listening on port ${PORT}`)
})

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`)
  server.close()
  await shutdownPool()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
