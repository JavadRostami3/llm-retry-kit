export function calculateBackoff(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number
): number {
  const exponential = initialDelayMs * Math.pow(2, attempt)
  const jitter = exponential * 0.25 * (Math.random() * 2 - 1)
  const delay = exponential + jitter

  return Math.min(Math.max(delay, initialDelayMs), maxDelayMs)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(createAbortError())
      },
      { once: true }
    )
  })
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const err = error as Error & {
    code?: unknown
    status?: unknown
    statusCode?: unknown
  }

  const status = toNumber(err.status ?? err.statusCode)
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== null && status >= 500 && status <= 599)
  ) {
    return true
  }

  const code = typeof err.code === 'string' ? err.code.toLowerCase() : ''
  if (
    [
      'etimedout',
      'econnreset',
      'econnrefused',
      'enotfound',
      'eai_again',
      'rate_limit_exceeded',
      'conflict',
      'overloaded_error',
    ].includes(code)
  ) {
    return true
  }

  const message = error.message.toLowerCase()
  const retryablePatterns = [
    'rate limit',
    'rate_limit',
    'too many requests',
    '429',
    '408',
    '409',
    'server error',
    '500',
    '502',
    '503',
    '504',
    'timeout',
    'timed out',
    'econnreset',
    'econnrefused',
    'network',
    'socket',
    'overloaded',
    'overloaded_error',
  ]

  return retryablePatterns.some((pattern) => message.includes(pattern))
}

export function extractRetryAfter(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null

  const err = error as Record<string, unknown>
  const retryAfter = toNumber(err['retryAfter'] ?? err['retry-after'])
  if (retryAfter !== null) {
    return retryAfter * 1000
  }

  const response = err['response'] as Record<string, unknown> | undefined
  const headerValue =
    getHeader(err['headers'], 'retry-after') ??
    getHeader(response?.['headers'], 'retry-after')
  if (!headerValue) {
    return null
  }

  const seconds = Number(headerValue)
  if (Number.isFinite(seconds)) {
    return seconds * 1000
  }

  const dateMs = Date.parse(headerValue)
  if (Number.isFinite(dateMs)) {
    return Math.max(dateMs - Date.now(), 0)
  }

  return null
}

export function createAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function getHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null

  if ('get' in headers && typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : null
  }

  const record = headers as Record<string, unknown>
  const matchedKey = Object.keys(record).find(
    (key) => key.toLowerCase() === name.toLowerCase()
  )

  if (!matchedKey) return null

  const value = record[matchedKey]
  return typeof value === 'string' ? value : null
}
