/**
 * History — capped per-target check history, persisted as one JSON file.
 * Same crash-safety conventions as agnes-kit/json-store (atomic rename,
 * corrupt file moved aside), tuned for high-frequency appends.
 */
import fs from 'node:fs'
import path from 'node:path'

const HISTORY_LIMIT = 2000

export class HistoryStore {
  constructor(dir, { file = 'history.json', limit = HISTORY_LIMIT, log = () => {} } = {}) {
    this.file = path.join(dir, file)
    this.limit = limit
    this.log = log
    fs.mkdirSync(dir, { recursive: true })
    this.data = this._load()
  }

  _load() {
    if (!fs.existsSync(this.file)) return []
    let text
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    try {
      const data = JSON.parse(text)
      return Array.isArray(data) ? data : []
    } catch (e) {
      try {
        const backup = this.file + `.corrupt-${Date.now()}`
        fs.renameSync(this.file, backup)
        this.log(`corrupt history backed up to ${backup}: ${e.message}`)
      } catch {}
      return []
    }
  }

  /** Append one check record; prunes to the cap; persists atomically. */
  append(record) {
    this.data.push({
      targetId: record.targetId,
      ts: record.ts,
      status: record.status,
      latencyMs: record.latencyMs,
      code: record.code,
      error: record.error ? String(record.error).slice(0, 200) : null,
    })
    if (this.data.length > this.limit) this.data.splice(0, this.data.length - this.limit)
    this._write()
  }

  /** Latest record per target — powers the "current state" panel. */
  latestPerTarget() {
    const out = new Map()
    for (const r of this.data) out.set(r.targetId, r)
    return [...out.values()]
  }

  /** All records for one target since `sinceMs` (oldest → newest). */
  forTarget(targetId, sinceMs = 0) {
    return this.data.filter((r) => r.targetId === targetId && r.ts >= sinceMs)
  }

  /** Aggregates for one target: uptime % and avg latency over the window. */
  aggregate(targetId, sinceMs = 0) {
    const rows = this.forTarget(targetId, sinceMs)
    const ups = rows.filter((r) => r.status === 'up').length
    const latencies = rows.filter((r) => r.status === 'up' && r.latencyMs != null).map((r) => r.latencyMs)
    return {
      checks: rows.length,
      ups,
      downs: rows.length - ups,
      uptimePct: rows.length ? Math.round((ups / rows.length) * 1000) / 10 : null,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    }
  }

  _write() {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
    fs.renameSync(tmp, this.file)
  }
}
