/**
 * HTTP E2E for the uptime-hud server: boots the real server from a throwaway
 * data dir + ephemeral port, probes a LOCAL mock upstream (no external
 * network), and verifies the API surface + persistence + dashboard.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let n = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); n++ }
  catch (e) { console.error(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1 }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

// ---- local mock upstream: /ok → 200, /down → 500, /flap alternates ----
let flapCount = 0
const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/down')) { res.writeHead(500); res.end('boom') }
  else if (req.url.startsWith('/flap')) { flapCount++; res.writeHead(flapCount % 2 === 0 ? 200 : 500); res.end() }
  else { res.writeHead(200); res.end('ok') }
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const upPort = upstream.address().port

// ---- boot the server with an isolated data dir + fixture targets ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-hud-e2e-'))
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const fixture = [
  { id: 'up', name: '正常站点', url: `http://127.0.0.1:${upPort}/ok`, intervalSec: 1 },
  { id: 'down', name: '故障站点', url: `http://127.0.0.1:${upPort}/down`, intervalSec: 1 },
]
fs.writeFileSync(path.join(tmp, 'targets.json'), JSON.stringify(fixture, null, 2), 'utf8')

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, UPTIME_DATA_DIR: tmp, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
const logs = []
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push(d.toString()))

let up = false
for (let i = 0; i < 50 && !up; i++) {
  try { up = (await fetch(`${base}/api/status`)).ok } catch { await sleep(250) }
}

try {
  if (!up) throw new Error('服务器未启动: ' + logs.join('').slice(-500))

  await test('仪表盘静态页可访问', async () => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /uptime-hud/)
    assert.match(html, /探测目标/)
  })

  await test('/api/status 汇报 fixture 目标并最终收敛 up/down', async () => {
    let settled = false
    let snap
    for (let i = 0; i < 40 && !settled; i++) {
      snap = await (await fetch(`${base}/api/status`)).json()
      const ids = Object.fromEntries(snap.targets.map((x) => [x.id, x.status]))
      settled = ids.up === 'up' && ids.down === 'down'
      if (!settled) await sleep(500)
    }
    assert.equal(settled, true, `状态未收敛: ${JSON.stringify(snap?.targets?.map((x) => [x.id, x.status]))}`)
    const ids = Object.fromEntries(snap.targets.map((x) => [x.id, x.status]))
    assert.equal(ids.up, 'up')
    assert.equal(ids.down, 'down')
  })

  await test('history 记录落盘,窗口聚合可用', async () => {
    const s = await (await fetch(`${base}/api/status`)).json()
    for (const t of s.targets) {
      const rows = s.history[t.id] ?? []
      assert.ok(rows.length >= 1, `${t.id} 应有历史记录`)
      const w = s.windows[t.id]
      assert.ok(w.h24.checks >= 1)
      assert.ok(typeof w.h24.uptimePct === 'number')
    }
    // 直接落盘证据:data/history.json 存在
    assert.ok(fs.existsSync(path.join(tmp, 'history.json')))
  })

  await test('POST /api/targets 添加目标并持久化到 targets.json', async () => {
    const res = await fetch(`${base}/api/targets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'flap', name: '抖动站点', url: `http://127.0.0.1:${upPort}/flap`, intervalSec: 1 }),
    })
    assert.equal(res.status, 200)
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'targets.json'), 'utf8'))
    assert.ok(onDisk.some((t) => t.id === 'flap'), 'targets.json 必须持久化新目标')
    // 无效 url → 400
    const bad = await fetch(`${base}/api/targets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://not-http' }),
    })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /http/)
  })

  await test('新目标会被真实探测并出现在 history 里', async () => {
    let rows = []
    for (let i = 0; i < 20 && !rows.length; i++) {
      await sleep(700)
      rows = (await (await fetch(`${base}/api/history/flap`)).json()).records
    }
    assert.ok(rows.length >= 1, 'flap 目标应被探测过')
    assert.ok(rows.every((r) => r.status === 'up' || r.status === 'down'))
  })

  await test('DELETE /api/targets/:id 移除并持久化', async () => {
    const res = await fetch(`${base}/api/targets/flap`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'targets.json'), 'utf8'))
    assert.ok(!onDisk.some((t) => t.id === 'flap'))
    const s = await (await fetch(`${base}/api/status`)).json()
    assert.ok(!s.targets.some((t) => t.id === 'flap'))
  })

  await test('targets.json 缺失时自动播种示例', async () => {
    // 用第二个隔离实例验证种子行为
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-hud-seed-'))
    const port2 = await freePort()
    const child2 = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, UPTIME_DATA_DIR: tmp2, PORT: String(port2) },
      stdio: 'ignore', windowsHide: true,
    })
    try {
      let ok = false
      for (let i = 0; i < 40 && !ok; i++) {
        try { ok = (await fetch(`http://127.0.0.1:${port2}/api/status`)).ok } catch { await sleep(250) }
      }
      assert.equal(ok, true)
      const seeded = JSON.parse(fs.readFileSync(path.join(tmp2, 'targets.json'), 'utf8'))
      assert.ok(seeded.length >= 1, '自动播种至少一个示例目标')
    } finally {
      killTree(child2)
    }
    fs.rmSync(tmp2, { recursive: true, force: true })
  })
} finally {
  killTree(child)
  await sleep(500)
  upstream.close()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`)
