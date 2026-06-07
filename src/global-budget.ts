import type { GlobalBudgetOptions, GlobalBudgetSnapshot } from './types.js'

interface BudgetEntry {
  timestamp: number
  costUSD: number
}

export class GlobalBudgetTracker {
  private entries: BudgetEntry[] = []

  constructor(private readonly options: GlobalBudgetOptions) {
    validateGlobalBudgetOptions(options)
  }

  add(costUSD: number): void {
    if (!Number.isFinite(costUSD) || costUSD < 0) {
      throw new Error('costUSD must be greater than or equal to 0')
    }

    this.prune()

    if (costUSD === 0) {
      return
    }

    this.entries.push({ timestamp: Date.now(), costUSD })
  }

  isExceeded(): boolean {
    this.prune()
    return this.spent >= this.options.maxCostUSD
  }

  get spent(): number {
    this.prune()
    return this.entries.reduce((total, entry) => total + entry.costUSD, 0)
  }

  get limit(): number {
    return this.options.maxCostUSD
  }

  snapshot(): GlobalBudgetSnapshot {
    this.prune()

    return {
      spentUSD: this.spent,
      limitUSD: this.options.maxCostUSD,
      windowMs: this.options.windowMs,
      resetAt: this.entries[0]
        ? this.entries[0].timestamp + this.options.windowMs
        : null,
      entries: this.entries.length,
    }
  }

  private prune(): void {
    const windowStart = Date.now() - this.options.windowMs
    this.entries = this.entries.filter((entry) => entry.timestamp > windowStart)
  }
}

function validateGlobalBudgetOptions(options: GlobalBudgetOptions): void {
  if (options.maxCostUSD < 0) {
    throw new Error('maxCostUSD must be greater than or equal to 0')
  }

  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new Error('windowMs must be greater than 0')
  }
}
