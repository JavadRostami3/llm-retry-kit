import type {
  CircuitBreakerOptions,
  CircuitBreakerSnapshot,
  CircuitBreakerState,
} from './types.js'

export class CircuitBreaker {
  private failureTimestamps: number[] = []
  private state: CircuitBreakerState = 'closed'
  private openedAt: number | null = null

  constructor(private readonly options: CircuitBreakerOptions) {
    validateCircuitBreakerOptions(options)
  }

  canRequest(): boolean {
    if (this.state !== 'open') {
      return true
    }

    const openedAt = this.openedAt ?? 0
    if (Date.now() - openedAt >= this.options.cooldownMs) {
      this.state = 'half_open'
      return true
    }

    return false
  }

  recordSuccess(): void {
    this.failureTimestamps = []
    this.state = 'closed'
    this.openedAt = null
  }

  recordFailure(): void {
    const now = Date.now()
    const windowStart = now - this.options.windowMs

    this.failureTimestamps = [...this.failureTimestamps, now].filter(
      (timestamp) => timestamp >= windowStart
    )

    if (
      this.state === 'half_open' ||
      this.failureTimestamps.length >= this.options.failureThreshold
    ) {
      this.state = 'open'
      this.openedAt = now
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      failures: this.failureTimestamps.length,
      openedAt: this.openedAt,
    }
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly provider: string) {
    super(`Circuit breaker is open for provider "${provider}"`)
    this.name = 'CircuitBreakerOpenError'
  }
}

function validateCircuitBreakerOptions(options: CircuitBreakerOptions): void {
  if (!Number.isInteger(options.failureThreshold) || options.failureThreshold <= 0) {
    throw new Error('failureThreshold must be a positive integer')
  }

  if (options.windowMs < 0) {
    throw new Error('windowMs must be greater than or equal to 0')
  }

  if (options.cooldownMs < 0) {
    throw new Error('cooldownMs must be greater than or equal to 0')
  }
}
