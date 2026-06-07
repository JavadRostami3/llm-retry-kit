import type {
  AdaptiveHedgeDelayOptions,
  AdaptiveHedgeDelaySnapshot,
  HedgeDelayRecord,
  RetryAttemptContext,
} from './types.js'

export class AdaptiveHedgeDelay {
  private readonly samplesByProvider = new Map<string, number[]>()
  private readonly sampleSize: number
  private readonly percentile: number
  private readonly minSamples: number
  private readonly minDelayMs: number | null
  private readonly maxDelayMs: number | null
  private readonly defaultDelayMs: number | null
  private readonly recordFailures: boolean

  constructor(options: AdaptiveHedgeDelayOptions = {}) {
    this.sampleSize = options.sampleSize ?? 100
    this.percentile = options.percentile ?? 0.95
    this.minSamples = options.minSamples ?? 5
    this.minDelayMs = options.minDelayMs ?? null
    this.maxDelayMs = options.maxDelayMs ?? null
    this.defaultDelayMs = options.defaultDelayMs ?? null
    this.recordFailures = options.recordFailures ?? false

    validateAdaptiveHedgeDelay({
      sampleSize: this.sampleSize,
      percentile: this.percentile,
      minSamples: this.minSamples,
      minDelayMs: this.minDelayMs,
      maxDelayMs: this.maxDelayMs,
      defaultDelayMs: this.defaultDelayMs,
    })
  }

  getDelayMs(context: RetryAttemptContext): number | null {
    const samples = this.samplesByProvider.get(context.provider) ?? []
    if (samples.length < this.minSamples) {
      return this.defaultDelayMs
    }

    return this.clamp(percentile(samples, this.percentile))
  }

  recordLatency(record: HedgeDelayRecord): void {
    if (!Number.isFinite(record.latencyMs) || record.latencyMs < 0) {
      return
    }

    if (record.outcome === 'failure' && !this.recordFailures) {
      return
    }

    const samples = this.samplesByProvider.get(record.provider) ?? []
    samples.push(record.latencyMs)

    if (samples.length > this.sampleSize) {
      samples.splice(0, samples.length - this.sampleSize)
    }

    this.samplesByProvider.set(record.provider, samples)
  }

  snapshot(): AdaptiveHedgeDelaySnapshot {
    const providers: AdaptiveHedgeDelaySnapshot['providers'] = {}

    for (const [provider, samples] of this.samplesByProvider) {
      providers[provider] = {
        samples: samples.length,
        delayMs: samples.length < this.minSamples
          ? this.defaultDelayMs
          : this.clamp(percentile(samples, this.percentile)),
      }
    }

    return {
      sampleSize: this.sampleSize,
      percentile: this.percentile,
      providers,
    }
  }

  private clamp(delayMs: number): number {
    let clamped = delayMs

    if (this.minDelayMs !== null) {
      clamped = Math.max(clamped, this.minDelayMs)
    }

    if (this.maxDelayMs !== null) {
      clamped = Math.min(clamped, this.maxDelayMs)
    }

    return clamped
  }
}

function percentile(samples: number[], value: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.ceil(value * sorted.length) - 1

  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)] ?? 0
}

function validateAdaptiveHedgeDelay(options: {
  sampleSize: number
  percentile: number
  minSamples: number
  minDelayMs: number | null
  maxDelayMs: number | null
  defaultDelayMs: number | null
}): void {
  if (!Number.isInteger(options.sampleSize) || options.sampleSize <= 0) {
    throw new Error('sampleSize must be a positive integer')
  }

  if (options.percentile <= 0 || options.percentile > 1) {
    throw new Error('percentile must be greater than 0 and less than or equal to 1')
  }

  if (!Number.isInteger(options.minSamples) || options.minSamples < 0) {
    throw new Error('minSamples must be a non-negative integer')
  }

  for (const [name, value] of [
    ['minDelayMs', options.minDelayMs],
    ['maxDelayMs', options.maxDelayMs],
    ['defaultDelayMs', options.defaultDelayMs],
  ] as const) {
    if (value !== null && value < 0) {
      throw new Error(`${name} must be greater than or equal to 0`)
    }
  }

  if (
    options.minDelayMs !== null &&
    options.maxDelayMs !== null &&
    options.maxDelayMs < options.minDelayMs
  ) {
    throw new Error('maxDelayMs must be greater than or equal to minDelayMs')
  }
}
