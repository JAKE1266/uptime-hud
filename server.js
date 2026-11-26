/**
 * uptime-hud server — zero-dependency: scheduler + status API + dashboard.
 *
 *   node server.js                    → http://127.0.0.1:8795
 *   PORT=9000 node server.js          custom port
 *   UPTIME_DATA_DIR=/tmp/x node ...   custom data dir (tests)
 *
 * Targets live in <dataDir>/targets.json (auto-seeded with one example).
 * Every probe result goes to HistoryStore (capped) and the event feed.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Monitor } from './lib/monitor.js'
import { HistoryStore } from './lib/history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.UPTIME_DATA_DIR || path.join(__dirname, 'data')
const targetsFile = path.join(dataDir, 'targets.json')
const PORT = Number(process.env.PORT) || 8795

fs.mkdirSync(dataDir, { recursive: true })

function loadTargets() {
  try {
    const list = JSON.parse(fs.readFileSync(targetsFile, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    const seed = [{
      id: 'example',
      name: '示例站点(编辑 data/targets.json)',
      url: 'https://example.com',
      intervalSec: 60,
    }]
    saveTargets(seed)
    return seed
  }
}

function saveTargets(list) {
  const tmp = targetsFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
  fs.renameSync(tmp, targetsFile)
}

// ---- engine wiring ----
const history = new HistoryStore(dataDir)
const events = []
const pushEvent = (e) => { events.push({ ...e, t: Date.now() }); if (events.length > 200) events.shift() }

const monitor = new Monitor({
  targets: loadTargets(),
  onCheck: (rec) => {
    history.append(rec)
    pushEvent({ kind: 'check', ...rec })
  },
  onEvent: (e) => pushEvent({ kind: 'event', ...e }),
})
monitor.start(1000)

const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}
const readBody = (req) => new Promise((resolve, reject) => {
  let buf = ''
  req.on('data', (c) => { buf += c; if (buf.length > 1e6) reject(new Error('body too large')) })
  req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}) } catch { reject(new Error('invalid JSON')) } })
})

function validateTargetBody(body) {
  const url = String(body.url ?? '').trim()
  if (!/^https?:\/\//.test(url)) return { error: 'url 必须以 http:// 或 https:// 开头' }
  const intervalSec = Number(body.intervalSec) > 0 ? Number(body.intervalSec) : 30
  return {
    target: {
      id: String(body.id ?? '').trim() || `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: String(body.name ?? '').trim() || url,
      url, intervalSec,
      ...(Number(body.timeoutMs) > 0 ? { timeoutMs: Number(body.timeoutMs) } : {}),
      ...(body.expectStatus != null ? { expectStatus: body.expectStatus } : {}),
    },
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (u.pathname === '/api/status' && req.method === 'GET') {
      const now = Date.now()
      const targets = monitor.snapshot()
      const historyOut = {}
      const windows = {}
      for (const t of targets) {
        historyOut[t.id] = history.forTarget(t.id, now - 24 * 3600 * 1000).slice(-60)
        windows[t.id] = {
          h1: history.aggregate(t.id, now - 3600 * 1000),
          h24: history.aggregate(t.id, now - 24 * 3600 * 1000),
        }
      }
      return json(res, 200, {
        now,
        port: PORT,
        targets,
        history: historyOut,
        windows,
        events: events.slice(-30).reverse(),
      })
    }

    if (u.pathname === '/api/targets' && req.method === 'GET') {
      return json(res, 200, monitor.targets.map((t) => ({ ...t })))
    }
    if (u.pathname === '/api/targets' && req.method === 'POST') {
      const body = await readBody(req)
      const { target, error } = validateTargetBody(body)
      if (error) return json(res, 400, { error })
      monitor.upsertTarget(target)
      saveTargets(monitor.targets.map((t) => ({
        id: t.id, name: t.name, url: t.url, method: t.method, intervalSec: t.intervalSec,
        timeoutMs: t.timeoutMs, ...(t.expectStatus != null ? { expectStatus: t.expectStatus } : {}),
      })))
      pushEvent({ kind: 'event', type: 'target-added', targetId: target.id })
      return json(res, 200, { ok: true, target })
    }
    const delMatch = u.pathname.match(/^\/api\/targets\/([^/]+)$/)
    if (delMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(delMatch[1])
      const ok = monitor.removeTarget(id)
      saveTargets(monitor.targets.map((t) => ({
        id: t.id, name: t.name, url: t.url, method: t.method, intervalSec: t.intervalSec,
        timeoutMs: t.timeoutMs, ...(t.expectStatus != null ? { expectStatus: t.expectStatus } : {}),
      })))
      pushEvent({ kind: 'event', type: 'target-removed', targetId: id })
      return json(res, 200, { ok, id })
    }
    const histMatch = u.pathname.match(/^\/api\/history\/([^/]+)$/)
    if (histMatch && req.method === 'GET') {
      const id = decodeURIComponent(histMatch[1])
      const since = Number(u.searchParams.get('sinceMs')) || 0
      return json(res, 200, { targetId: id, records: history.forTarget(id, since) })
    }

    // ---- static dashboard ----
    let file = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).slice(1)
    const filePath = path.join(__dirname, 'public', file)
    if (!filePath.startsWith(path.join(__dirname, 'public') + path.sep) && filePath !== path.join(__dirname, 'public', 'index.html')) {
      return json(res, 403, { error: 'Forbidden' })
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath)
      const ct = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[ext] ?? 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': ct })
      return res.end(fs.readFileSync(filePath))
    }
    return json(res, 404, { error: 'Not found' })
  } catch (e) {
    return json(res, e.status ?? 500, { error: e.message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`uptime-hud → http://127.0.0.1:${PORT}`)
  console.log(`探测目标 ${monitor.targets.length} 个,数据目录 ${dataDir}`)
})
process.on('SIGINT', () => { monitor.stop(); server.close(); process.exit(0) })
