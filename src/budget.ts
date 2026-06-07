import type { TokenUsage } from './types.js'

export class BudgetTracker {
  private totalTokens = 0
  private totalCostUSD = 0
  private readonly costPer1kTokens: number
  private readonly maxCostUSD: number | null

  constructor(costPer1kTokens: number, maxCostUSD?: number) {
    if (costPer1kTokens < 0) {
      throw new Error('costPer1kTokens must be greater than or equal to 0')
    }

    if (maxCostUSD !== undefined && maxCostUSD < 0) {
      throw new Error('maxCostUSD must be greater than or equal to 0')
    }

    this.costPer1kTokens = costPer1kTokens
    this.maxCostUSD = maxCostUSD ?? null
  }

  add(usage: TokenUsage, costUSD?: number): void {
    this.totalTokens += usage.totalTokens
    this.totalCostUSD += costUSD ?? this.estimate(usage)
  }

  estimate(usage: TokenUsage): number {
    return (usage.totalTokens / 1000) * this.costPer1kTokens
  }

  isExceeded(): boolean {
    if (this.maxCostUSD === null) return false
    return this.totalCostUSD >= this.maxCostUSD
  }

  get spent(): number {
    return this.totalCostUSD
  }

  get tokens(): number {
    return this.totalTokens
  }

  get limit(): number | null {
    return this.maxCostUSD
  }

  summary(): string {
    const cost = this.totalCostUSD.toFixed(4)
    const limit = this.maxCostUSD !== null ? `/ $${this.maxCostUSD}` : ''
    return `$${cost}${limit} (${this.totalTokens.toLocaleString()} tokens)`
  }
}
