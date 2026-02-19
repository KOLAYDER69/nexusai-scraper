import { Router } from 'express'
import { poolStats, isProxyActive } from '../browser/pool'
import { getPoolSize } from '../browser/proxy'

const router = Router()

router.get('/health', (_req, res) => {
  const stats = poolStats()
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    pool: stats,
    proxy: {
      configured: isProxyActive(),
      poolSize: getPoolSize(),
    },
  })
})

export default router
