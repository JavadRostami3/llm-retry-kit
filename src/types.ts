export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LLMResponse<T = unknown> {
  data: T
  usage?: TokenUsage
}

export interface RetryAttemptContext {
  attempt: number
  retryAttempt: number
  provider: string
  providerIndex: number
  elapsedMs: number
  signal?: AbortSignal
  lastError?: Error
  meta?: unknown
  payload?: unknown
}

export interface RetryDecisionContext extends RetryAttemptContext {
  maxRetries: number
  defaultShouldRetry: boolean
}

export interface FallbackDecisionContext extends RetryAttemptContext {
  defaultShouldFallback: boolean
  nextProvider?: string
  nextProviderIndex?: number
}

export interface RetrySuccessContext extends RetryAttemptContext {
  costUSD: number
  totalCostUSD: number
  totalTokens: number
}

export interface RetryFailureContext {
  attempts: number
  totalCostUSD: number
  totalTokens: number
  providers: string[]
  meta?: unknown
  payload?: unknown
}

export interface HedgeDelayRecord {
  provider: string
  providerIndex: number
  latencyMs: number
  outcome: 'success' | 'failure'
  hedged: boolean
}

export interface HedgeDelayStrategy {
  getDelayMs: (context: RetryAttemptContext) => number | null | undefined
  recordLatency: (record: HedgeDelayRecord) => void
}

export interface AdaptiveHedgeDelayOptions {
  sampleSize?: number
  percentile?: number
  minSamples?: number
  minDelayMs?: number
  maxDelayMs?: number
  defaultDelayMs?: number
  recordFailures?: boolean
}

export interface AdaptiveHedgeDelaySnapshot {
  sampleSize: number
  percentile: number
  providers: Record<string, {
    samples: number
    delayMs: number | null
  }>
}

export type LLMCall<T = unknown> = (
  context: RetryAttemptContext
) => Promise<LLMResponse<T>>

export type CostCalculator = (usage: TokenUsage, context: RetryAttemptContext) => number

export type ShouldRetry = (
  error: Error,
  context: RetryDecisionContext
) => boolean | Promise<boolean>

export type ShouldFallback = (
  error: Error,
  context: FallbackDecisionContext
) => boolean | Promise<boolean>

export interface RetryProvider<T = unknown> {
  name: string
  fn: LLMCall<T>
  maxRetries?: number
  timeoutMs?: number
  hedgeDelayMs?: number
  hedgeDelayStrategy?: HedgeDelayStrategy
  circuitBreaker?: CircuitBreakerLike
  costPer1kTokens?: number
  costCalculator?: CostCalculator
}

export interface CircuitBreakerOptions {
  failureThreshold: number
  windowMs: number
  cooldownMs: number
}

export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerSnapshot {
  state: CircuitBreakerState
  failures: number
  openedAt: number | null
}

export interface CircuitBreakerLike {
  canRequest: () => boolean
  recordSuccess: () => void
  recordFailure: () => void
  snapshot?: () => CircuitBreakerSnapshot
}

export interface GlobalBudgetOptions {
  maxCostUSD: number
  windowMs: number
}

export interface GlobalBudgetSnapshot {
  spentUSD: number
  limitUSD: number
  windowMs: number
  resetAt: number | null
  entries: number
}

export interface GlobalBudgetLike {
  add: (costUSD: number) => void
  isExceeded: () => boolean
  spent: number
  limit: number
  snapshot?: () => GlobalBudgetSnapshot
}

export interface RetryOptions<T = unknown> {
  fn?: LLMCall<T>
  fallback?: LLMCall<T>
  providers?: Array<RetryProvider<T>>
  maxRetries?: number
  maxCostUSD?: number
  globalBudget?: GlobalBudgetLike
  costPer1kTokens?: number
  costCalculator?: CostCalculator
  initialDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  hedgeDelayMs?: number
  hedgeDelayStrategy?: HedgeDelayStrategy
  signal?: AbortSignal
  meta?: unknown
  payload?: unknown
  shouldRetry?: ShouldRetry
  shouldFallback?: ShouldFallback
  onAttempt?: (context: RetryAttemptContext) => void
  onRetry?: (
    attempt: number,
    error: Error,
    delayMs: number,
    context: RetryDecisionContext
  ) => void
  onSuccess?: (context: RetrySuccessContext) => void
  onFailure?: (error: Error, context: RetryFailureContext) => void
  onBudgetExceeded?: (spentUSD: number, limitUSD: number) => void
}

export interface RetryResult<T = unknown> {
  data: T
  attempts: number
  provider: string
  usedFallback: boolean
  totalCostUSD: number
  totalTokens: number
}

export type RetryableError =
  | 'rate_limit'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'conflict'
  | 'overloaded'

export type StreamRetryMode = 'before-first-chunk' | 'always' | 'never'

export type StreamUsageMode = 'delta' | 'cumulative'

export type StreamLLMCall<TChunk = unknown> = (
  context: RetryAttemptContext
) => AsyncIterable<TChunk> | Promise<AsyncIterable<TChunk>>

export type StreamUsageExtractor<TChunk = unknown> = (
  chunk: TChunk,
  context: RetryAttemptContext
) => TokenUsage | undefined

export interface StreamRetryProvider<TChunk = unknown> {
  name: string
  stream: StreamLLMCall<TChunk>
  maxRetries?: number
  timeoutMs?: number
  circuitBreaker?: CircuitBreakerLike
  costPer1kTokens?: number
  costCalculator?: CostCalculator
}

export interface StreamRetryOptions<TChunk = unknown> {
  stream?: StreamLLMCall<TChunk>
  fallbackStream?: StreamLLMCall<TChunk>
  providers?: Array<StreamRetryProvider<TChunk>>
  maxRetries?: number
  maxCostUSD?: number
  globalBudget?: GlobalBudgetLike
  costPer1kTokens?: number
  costCalculator?: CostCalculator
  initialDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  meta?: unknown
  payload?: unknown
  retryMode?: StreamRetryMode
  getChunkUsage?: StreamUsageExtractor<TChunk>
  chunkUsageMode?: StreamUsageMode
  shouldRetry?: ShouldRetry
  shouldFallback?: ShouldFallback
  onAttempt?: (context: RetryAttemptContext) => void
  onRetry?: (
    attempt: number,
    error: Error,
    delayMs: number,
    context: RetryDecisionContext
  ) => void
  onChunk?: (chunk: TChunk, context: RetryAttemptContext) => void | Promise<void>
  onChunkError?: (error: Error, chunk: TChunk, context: RetryAttemptContext) => void | Promise<void>
  onChunkErrorMode?: 'ignore' | 'throw'
  onSuccess?: (context: RetrySuccessContext) => void
  onFailure?: (error: Error, context: RetryFailureContext) => void
  onBudgetExceeded?: (spentUSD: number, limitUSD: number) => void
}

export interface StreamRetryStats {
  attempts: number
  provider?: string
  usedFallback: boolean
  totalCostUSD: number
  totalTokens: number
  chunks: number
  completed: boolean
  lastError?: Error
}

export interface StreamRetryResult<TChunk = unknown> {
  stream: AsyncIterable<TChunk>
  getStats: () => StreamRetryStats
}
