/**
 * In-memory, per-tab TTL cache with in-flight de-duplication. Switching
 * between recent contacts re-uses the cached entry until it expires or
 * the caller forces a refresh — keeps request volume to the (serverless)
 * LMS low. No data-fetching library is used in this repo, so this is
 * deliberately small and framework-free.
 */
export const LMS_CACHE_TTL_MS = 7 * 60 * 1000
const MAX_ENTRIES = 100

interface Entry<T> {
  value: T
  expiresAt: number
}

export class TtlCache<T> {
  private entries = new Map<string, Entry<T>>()
  private inflight = new Map<string, Promise<T>>()

  constructor(
    private ttlMs: number = LMS_CACHE_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  peek(key: string): T | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return e.value
  }

  async get(
    key: string,
    loader: () => Promise<T>,
    opts: { force?: boolean } = {},
  ): Promise<T> {
    if (!opts.force) {
      const hit = this.peek(key)
      if (hit !== undefined) return hit
      const pending = this.inflight.get(key)
      if (pending) return pending
    }
    const p = loader()
      .then((value) => {
        this.set(key, value)
        return value
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key)
      })
    this.inflight.set(key, p)
    return p
  }

  private set(key: string, value: T) {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  delete(key: string) {
    this.entries.delete(key)
    this.inflight.delete(key)
  }

  clear() {
    this.entries.clear()
    this.inflight.clear()
  }
}
