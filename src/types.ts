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
}

export interface RetryDecisionContext extends RetryAttemptContext {
  maxRetries: number
}

export interface RetrySuccessContext extends RetryAttemptContext {
  costUSD: number
  totalCostUSD: number
  totalTokens: number
}

export type LLMCall<T = unknown> = (
  context: RetryAttemptContext
) => Promise<LLMResponse<T>>

export type CostCalculator = (usage: TokenUsage, context: RetryAttemptContext) => number

export type ShouldRetry = (
  error: Error,
  context: RetryDecisionContext
) => boolean | Promise<boolean>

export interface RetryProvider<T = unknown> {
  name: string
  fn: LLMCall<T>
  maxRetries?: number
  costPer1kTokens?: number
  costCalculator?: CostCalculator
}

export interface RetryOptions<T = unknown> {
  fn?: LLMCall<T>
  fallback?: LLMCall<T>
  providers?: Array<RetryProvider<T>>
  maxRetries?: number
  maxCostUSD?: number
  costPer1kTokens?: number
  costCalculator?: CostCalculator
  initialDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  shouldRetry?: ShouldRetry
  onAttempt?: (context: RetryAttemptContext) => void
  onRetry?: (
    attempt: number,
    error: Error,
    delayMs: number,
    context: RetryDecisionContext
  ) => void
  onSuccess?: (context: RetrySuccessContext) => void
  onFailure?: (error: Error) => void
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
