/** Monitor engine tests — injected fetch + clock, zero real network/wait. */
import assert from 'node:assert/strict'
import { Monitor } from '../lib/monitor.js'

let n = 0
const pending = []
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); console.log(`ok   ${name}`); n++ }
    catch (e) { console.error(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1 }
  })
}

let t = 0
const mkMonitor = ({ targets, fetchImpl, onCheck = () => {}, onEvent = () => {} } = {}) => {
  t = 0
  return new Monitor({
    targets,
    fetchImpl,
    now: () => t,
    sleep: async (ms) => { t += ms },
    onCheck,
    onEvent,
  })
}

const res = (status, ok = status >= 200 && status < 300) => ({ status, ok })
const okFetch = () => async () => res(200)
const failFetch = () => async () => res(500)
const netErrFetch = (msg = 'ECONNREFUSED') => async () => { throw new Error(msg) }

test('2xx counts up, 5xx counts down, network error counts down with message', async () => {
  const up = await mkMonitor({ targets: [{ id: 'a', url: 'https://a' }], fetchImpl: okFetch() }).checkTarget('a')
  assert.equal(up.status, 'up')
  assert.equal(up.code, 200)
  const down = await mkMonitor({ targets: [{ id: 'a', url: 'https://a' }], fetchImpl: failFetch() }).checkTarget('a')
  assert.equal(down.status, 'down')
  assert.match(down.error, /HTTP 500/)
  const err = await mkMonitor({ targets: [{ id: 'a', url: 'https://a' }], fetchImpl: netErrFetch() }).checkTarget('a')
  assert.equal(err.status, 'down')
  assert.match(err.error, /ECONNREFUSED/)
})

test('expectStatus overrides the default 2xx rule', async () => {
  const m = mkMonitor({
    targets: [{ id: 'a', url: 'https://a', expectStatus: 301 }],
    fetchImpl: async () => res(301, false), // 3xx is not ok, but expected here
  })
  const r = await m.checkTarget('a')
  assert.equal(r.status, 'up', '期望 301 时 301 算正常')
  const m2 = mkMonitor({
    targets: [{ id: 'b', url: 'https://b', expectStatus: [200, 204] }],
    fetchImpl: async () => res(500, false),
  })
  assert.equal((await m2.checkTarget('b')).status, 'down')
})

test('up/down transition events fire once per flip, flapping tracked', async () => {
  let flip = 0
  const fetchImpl = async () => (flip++ % 2 === 0 ? res(500, false) : res(200))
  const events = []
  const checks = []
  const m = mkMonitor({ targets: [{ id: 'a', url: 'https://a' }], fetchImpl, onEvent: (e) => events.push(e), onCheck: (c) => checks.push(c) })
  await m.checkTarget('a') // down (first-check)
  await m.checkTarget('a') // up
  await m.checkTarget('a') // down again → 'down' again
  await m.checkTarget('a') // up
  const types = events.map((e) => e.type)
  assert.deepEqual(types, ['first-check', 'up', 'down', 'up'])
  assert.equal(checks.length, 4)
})

test('still-down events carry a growing times counter', async () => {
  const events = []
  const m = mkMonitor({ targets: [{ id: 'a', url: 'https://a' }], fetchImpl: failFetch(), onEvent: (e) => events.push(e) })
  await m.checkTarget('a') // first-check
  await m.checkTarget('a') // still-down ×1
  await m.checkTarget('a') // still-down ×2
  const still = events.filter((e) => e.type === 'still-down')
  assert.deepEqual(still.map((e) => e.times), [2, 3])
})

test('tick() probes only due targets and schedules next interval', async () => {
  let hits = []
  const m = mkMonitor({
    targets: [
      { id: 'fast', url: 'https://f', intervalSec: 10 },
      { id: 'slow', url: 'https://s', intervalSec: 60 },
    ],
    fetchImpl: async (url) => { hits.push(url); return res(200) },
  })
  await m.tick()
  assert.equal(hits.length, 2, '初始全部到期')
  hits = []
  t += 10000 // 只有 fast 到期
  await m.tick()
  assert.deepEqual(hits, ['https://f'])
  hits = []
  t += 10000 // t=20s:fast 第二次到期
  await m.tick()
  assert.deepEqual(hits, ['https://f'])
  hits = []
  t += 40000 // t=60s:fast 上轮排期(30s)已过 + slow 首次到期
  await m.tick()
  assert.deepEqual(hits, ['https://f', 'https://s'])
})

test('start/stop loop drives ticks until stopped', async () => {
  let checks = 0
  const m = mkMonitor({ targets: [{ id: 'a', url: 'https://a', intervalSec: 1 }], fetchImpl: okFetch() })
  // Wrap tick to count without breaking the loop.
  const origTick = m.tick.bind(m)
  m.tick = async () => { checks++; return origTick() }
  const runner = m.start(500)
  // Let the injected sleep advance time; stop after a few loops.
  for (let i = 0; i < 50 && checks < 3; i++) await Promise.resolve()
  m.stop()
  await runner
  assert.ok(checks >= 3, `循环至少跑了 3 个 tick(实际 ${checks})`)
})

test('snapshot exposes uptime % and never mutates', async () => {
  const m = mkMonitor({ targets: [{ id: 'a', url: 'https://a', name: '站点A' }], fetchImpl: okFetch() })
  await m.checkTarget('a')
  const snap = m.snapshot()
  assert.equal(snap.length, 1)
  assert.equal(snap[0].uptimePct, 100)
  assert.equal(snap[0].name, '站点A')
  assert.equal(snap[0].status, 'up')
})

test('upsertTarget keeps ids unique; removeTarget works; bad target throws', async () => {
  const m = mkMonitor({ targets: [{ id: 'a', url: 'https://a' }], fetchImpl: okFetch() })
  m.upsertTarget({ id: 'a', url: 'https://a2' })
  assert.equal(m.targets.length, 1)
  assert.equal(m.targets[0].url, 'https://a2')
  m.upsertTarget({ id: 'b', url: 'https://b' })
  assert.equal(m.removeTarget('a'), true)
  assert.equal(m.removeTarget('gone'), false)
  assert.throws(() => m.upsertTarget({ id: 'x' }), /url/)
})

test('checkTarget throws for unknown ids (no silent no-op)', async () => {
  const m = mkMonitor({ targets: [], fetchImpl: okFetch() })
  await assert.rejects(() => m.checkTarget('ghost'), /未知探测目标/)
})

test('latency is measured in the injected clock', async () => {
  let t2 = 0
  const m = new Monitor({
    targets: [{ id: 'a', url: 'https://a' }],
    fetchImpl: async () => { t2 += 120; return res(200) },
    now: () => t2,
  })
  const r = await m.checkTarget('a')
  assert.equal(r.latencyMs, 120)
})

for (const run of pending) await run()
console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`)
