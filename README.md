# uptime-hud

零依赖**本地站点健康监控**:定时探测一组 URL,延迟/状态落盘,浏览器仪表盘实时查看可用率、上下线时间轴与事件流。纯 Node.js(≥18),无任何第三方依赖。

## 快速开始

```bash
npm test            # 26 项断言(mock fetch + 真实服务器 E2E)
node server.js      # → http://127.0.0.1:8795
```

首次启动自动播种示例配置 `data/targets.json`:

```json
[
  { "id": "example", "name": "示例站点", "url": "https://example.com", "intervalSec": 60 }
]
```

编辑该文件(或在仪表盘上增删)后立即生效。可选字段:`expectStatus`(如 `301` 或 `[200,204]`,默认 2xx 算正常)、`timeoutMs`、`method`、`headers`。`PORT` 环境变量换端口,`UPTIME_DATA_DIR` 换数据目录。

## 仪表盘

- 每个目标一张卡片:状态灯(绿/红/灰)、延迟、**1h / 24h 可用率**、探测次数、最近错误
- 迷你时间轴:最近 60 次探测逐条着色(绿 up / 红 down),悬停看时间与状态码
- 事件流:状态翻转、持续失败次数、目标增删
- 表单添加目标(URL + 名称 + 间隔),✕ 删除——全部持久化到 `data/targets.json`

## API

```
GET    /api/status                 全量快照(目标状态 + 24h 历史 + 1h/24h 聚合 + 事件流)
GET    /api/targets                配置列表
POST   /api/targets                { url, name?, intervalSec?, expectStatus?, timeoutMs? }
DELETE /api/targets/:id            移除目标
GET    /api/history/:id?sinceMs=   单目标原始记录
GET    /                           仪表盘
```

## 设计

- **引擎与 IO 分离**:`lib/monitor.js` 只管"怎么判、何时探",fetch 与时钟全部可注入——测试零网络、零等待、确定性
- **探测分类**:默认 `res.ok`(2xx);配 `expectStatus` 后按白名单;超时/网络错误按 down 记录并保留错误消息
- **翻转事件**:`first-check` → `up`/`down` 只在状态翻转时发,持续失败发 `still-down`(带连续次数),不刷屏
- **历史封顶**:单文件 2000 条,原子写(rename),损坏文件移走备份——约定与 agnes-kit/json-store 一致
- 调度循环每 1s tick 一次,只探测到期目标;探测按顺序执行,日志与历史时间线稳定

## 文件结构

```
uptime-hud/
├── server.js             # HTTP 服务 + 调度接线 + targets.json 持久化
├── public/index.html     # 仪表盘(单文件,无构建)
├── lib/
│   ├── monitor.js        # 探测引擎(分类/事件/调度,fetch+时钟可注入)
│   └── history.js        # 封顶历史存储(原子写/损坏备份/聚合)
└── test/                 # monitor(10) + history(6) + server E2E(7) + 语法(3) = 26 项
```

## License

MIT
