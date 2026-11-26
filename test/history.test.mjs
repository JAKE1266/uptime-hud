/** HistoryStore tests: append/prune/latest/aggregate + corrupt backup. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../lib/history.js'

let n = 0
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); n++ }
  catch (e) { console.error(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1 }
}

const mk = (limit) => new HistoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-hud-h-')), { limit })

const rec = (targetId, ts, status, latencyMs = 100) => ({ targetId, ts, status, latencyMs, code: status === 'up' ? 200 : 500, error: status === 'up' ? null : 'HTTP 500' })

test('append persists to disk and survives a new store instance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-hud-h-'))
  const s1 = new HistoryStore(dir)
  s1.append(rec('a', 1000, 'up', 42))
  s1.append(rec('a', 2000, 'down'))
  const s2 = new HistoryStore(dir)
  assert.equal(s2.forTarget('a').length, 2)
})

test('prune keeps only the newest `limit` records', () => {
  const s = mk(5)
  for (let i = 1; i <= 10; i++) s.append(rec('a', i * 1000, 'up'))
  const rows = s.forTarget('a')
  assert.equal(rows.length, 5)
  assert.equal(rows[0].ts, 6000, '最旧的被裁掉')
  assert.equal(rows[rows.length - 1].ts, 10000)
})

test('latestPerTarget returns the newest record for each target', () => {
  const s = mk()
  s.append(rec('a', 1000, 'up'))
  s.append(rec('b', 1500, 'up'))
  s.append(rec('a', 3000, 'down'))
  const latest = s.latestPerTarget()
  assert.equal(latest.length, 2)
  const a = latest.find((r) => r.targetId === 'a')
  assert.equal(a.status, 'down')
  assert.equal(a.ts, 3000)
})

test('aggregate computes uptime % and avg latency over a window', () => {
  const s = mk()
  s.append(rec('a', 1000, 'up', 100))
  s.append(rec('a', 2000, 'up', 300))
  s.append(rec('a', 3000, 'down'))
  s.append(rec('b', 4000, 'up', 50)) // 别的目标不影响聚合
  const agg = s.aggregate('a')
  assert.equal(agg.checks, 3)
  assert.equal(agg.ups, 2)
  assert.equal(agg.downs, 1)
  assert.equal(agg.uptimePct, 66.7)
  assert.equal(agg.avgLatencyMs, 200, '只统计成功探测的延迟')
  // 窗口过滤:只看 2500ms 之后
  const recent = s.aggregate('a', 2500)
  assert.equal(recent.checks, 1)
  assert.equal(recent.uptimePct, 0)
})

test('forTarget filters by sinceMs and keeps order', () => {
  const s = mk()
  s.append(rec('a', 1000, 'up'))
  s.append(rec('a', 2000, 'up'))
  s.append(rec('a', 3000, 'up'))
  const rows = s.forTarget('a', 2000)
  assert.deepEqual(rows.map((r) => r.ts), [2000, 3000])
})

test('corrupt history file is moved aside, store starts clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-hud-h-'))
  fs.writeFileSync(path.join(dir, 'history.json'), '{ broken', 'utf8')
  const s = new HistoryStore(dir)
  assert.deepEqual(s.latestPerTarget(), [])
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))
  assert.equal(backups.length, 1)
  s.append(rec('a', 1000, 'up'))
  assert.equal(s.forTarget('a').length, 1)
})

console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`)
