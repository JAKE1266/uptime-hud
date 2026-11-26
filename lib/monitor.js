/**
 * Monitor — the probing engine for uptime-hud. Zero dependencies.
 *
 * Owns the WHAT (classify a probe result) and the WHEN (per-target intervals,
 * due scheduling). It does NOT own storage (callers get every check via
 * onCheck) nor transport (fetch is injectable) nor wall-clock time (injectable
 * — tests run instantly and deterministically).
 *
 * A target: {
 *   id, url,
 *   name?, method?, headers?,
 *   expectStatus?: number | number[]   (default: any 2xx via res.ok)
 *   intervalSec?: number               (default 30)
 *   timeoutMs?: number                 (default 5000)
 * }
 *
 * Status transitions fire events (flapping-aware):
 *   'check'  every probe result
 *   'down'   first failure after ≥1 success (or first check failing)
 *   'up'     first success after a failure
 */

const DEFAULT_INTERVAL_SEC = 30
const DEFAULT_TIMEOUT_MS = 5000

export class Monitor {
  constructor({ targets = [], fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onCheck = () => {}, onEvent = () => {} } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.sleep = sleep
    this.onCheck = onCheck
    this.onEvent = onEvent
    this.running = false
    this.targets = targets.map((t) => this._initTarget(t))
  }

  _initTarget(t) {
    const url = String(t.url ?? '').trim()
    if (!url) throw new Error(`target 缺少 url: ${JSON.stringify(t)}`)
    return {
      id: t.id ?? url,
      name: t.name ?? url,
      url,
      method: t.method ?? 'GET',
      headers: t.headers ?? {},
      expectStatus: t.expectStatus ?? null,
      intervalSec: Number(t.intervalSec) > 0 ? Number(t.intervalSec) : DEFAULT_INTERVAL_SEC,
      timeoutMs: Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : DEFAULT_TIMEOUT_MS,
      // live state
      status: 'unknown',
      lastLatencyMs: null,
      lastCheckTs: null,
      lastError: null,
      consecutiveFails: 0,
      consecutiveOk: 0,
      nextDueAt: 0,   // due immediately
      checks: 0,
      ups: 0,
      downs: 0,
    }
  }

  /** Replace/append targets at runtime; new targets are due immediately. */
  upsertTarget(t) {
    const init = this._initTarget(t)
    const i = this.targets.findIndex((x) => x.id === init.id)
    // Preserve continuity when re-configuring the same id.
    Object.assign(init, {
      status: 'unknown', lastLatencyMs: null, lastCheckTs: null, lastError: null,
      consecutiveFails: 0, consecutiveOk: 0, nextDueAt: 0, checks: 0, ups: 0, downs: 0,
    })
    if (i >= 0) this.targets[i] = init
    else this.targets.push(init)
    return init
  }

  removeTarget(id) {
    const before = this.targets.length
    this.targets = this.targets.filter((x) => x.id !== id)
    return this.targets.length < before
  }

  /** Does a response satisfy the target's expectation? */
  _isExpected(target, res) {
    if (target.expectStatus != null) {
      const want = Array.isArray(target.expectStatus) ? target.expectStatus : [target.expectStatus]
      return want.includes(res.status)
    }
    return res.ok // default: 2xx
  }

  /** Probe ONE target. Records the result, fires events, returns the record. */
  async checkTarget(targetId) {
    const target = this.targets.find((x) => x.id === targetId) ?? this.targets.find((x) => x.url === targetId)
    if (!target) throw new Error(`未知探测目标: ${targetId}`)
    const t = this.now()
    let record
    try {
      const started = this.now()
      const res = await this.fetch(target.url, {
        method: target.method,
        headers: target.headers,
        signal: AbortSignal.timeout(target.timeoutMs),
      })
      const latencyMs = Math.max(0, this.now() - started)
      const up = this._isExpected(target, res)
      record = {
        targetId: target.id, ts: t, latencyMs,
        status: up ? 'up' : 'down',
        code: res.status,
        error: up ? null : `HTTP ${res.status}(期望 ${target.expectStatus ?? '2xx'})`,
      }
    } catch (e) {
      record = {
        targetId: target.id, ts: t, latencyMs: null,
        status: 'down', code: null,
        error: `网络错误: ${e.message}`,
      }
    }
    this._record(target, record)
    this.onCheck(record)
    return record
  }

  _record(target, record) {
    const prev = target.status
    target.status = record.status
    target.lastLatencyMs = record.latencyMs
    target.lastCheckTs = record.ts
    target.lastError = record.error
    target.checks++
    if (record.status === 'up') {
      target.ups++
      target.consecutiveOk++
      target.consecutiveFails = 0
      if (prev === 'down' || prev === 'unknown') this.onEvent({ type: prev === 'unknown' ? 'first-check' : 'up', targetId: target.id, ...record })
    } else {
      target.downs++
      target.consecutiveFails++
      target.consecutiveOk = 0
      if (prev === 'up' || prev === 'unknown') this.onEvent({ type: prev === 'unknown' ? 'first-check' : 'down', targetId: target.id, ...record })
      else this.onEvent({ type: 'still-down', targetId: target.id, ...record, times: target.consecutiveFails })
    }
  }

  /** Targets whose nextDueAt has passed (or never run). */
  dueTargets() {
    const t = this.now()
    return this.targets.filter((x) => x.nextDueAt <= t)
  }

  /** Probe every due target sequentially (keeps probes ordered + logs sane). */
  async tick() {
    const due = this.dueTargets()
    const results = []
    for (const target of due) {
      const r = await this.checkTarget(target.id)
      target.nextDueAt = this.now() + target.intervalSec * 1000
      results.push(r)
    }
    return results
  }

  /** Run forever, ticking every `tickMs` (injectable sleep → testable). */
  async start(tickMs = 1000) {
    if (this.running) return
    this.running = true
    while (this.running) {
      try { await this.tick() } catch (e) { this.onEvent({ type: 'tick-error', error: e.message }) }
      await this.sleep(tickMs)
    }
  }

  stop() { this.running = false }

  /** UI snapshot: current state of every target (no mutation). */
  snapshot() {
    return this.targets.map((t) => ({
      id: t.id, name: t.name, url: t.url, intervalSec: t.intervalSec,
      status: t.status, latencyMs: t.lastLatencyMs, lastCheckTs: t.lastCheckTs,
      lastError: t.lastError, checks: t.checks, ups: t.ups, downs: t.downs,
      uptimePct: t.checks ? Math.round((t.ups / t.checks) * 1000) / 10 : null,
    }))
  }
}
