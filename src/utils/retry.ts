export type RetryOptions = {
  maxRetries?: number
  baseDelay?: number
  retryableStatuses?: number[]
  onRetry?: (attempt: number, error: unknown) => void
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    retryableStatuses = [403, 429],
    onRetry,
  } = opts

  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err

      const status = (err as { status?: number }).status
      const isRetryable = status !== undefined && retryableStatuses.includes(status)

      if (attempt >= maxRetries || !isRetryable) {
        throw err
      }

      onRetry?.(attempt + 1, err)
      const delay = baseDelay * Math.pow(2, attempt)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  throw lastError
}
