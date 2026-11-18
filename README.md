# 发票接入 · Invoice Intake

监控本地目录中的供应商发票文件（XML / PDF），按供应商规则解析，保存原文 SHA-256、结构化字段和解析器版本。解析器升级后可对历史文件重放；字段缺失或金额校验不一致的文件进入人工隔离队列，已确认结果永远不会被重放或重复文件覆盖。

零运行时依赖：Node.js 内置 `node:http`、`node:sqlite`、`node:zlib`；前端是原生 HTML/CSS/JS。

```bash
node --version              # 需要 >= 22.5（node:sqlite）
npm run seed -- --reset     # 生成演示批次 / 隔离 / 重放历史
npm start                   # http://localhost:4477
npm test                    # 49 个测试
```

`npm run seed` 会在 `inbox/` 放下样例文件并写入 `data/intake.db`。之后往 `inbox/` 里拖入 XML/PDF 也可以在页面上看到新批次。

## 处理流程

```
inbox/ ──► 扫描（稳定判定）──► 哈希 ──► 去重 ──► 识别供应商 ──► 解析 ──► 校验
                  │                 │                          │          │
              半写入→等待      原文相同→重复                未知/损坏    缺失/金额不符
                                                                   │          │
                                                              隔离队列 ◄──────┘
                                                                   │
                                              确认 ◄── 人工处理 ──►┘
                                                                   │
解析器升级 ──► 从归档读回原文（校验哈希）──► 用新版本重放 ──► 字段级差异 ──► 已确认文档只提示差异
```

### 1. 监控与半写入保护

- 文件只有在**连续两次扫描**中大小与 mtime 完全一致、且 mtime 早于 `SETTLE_MS` 时才读取；首次出现一律「等待稳定」。
- 读取前后各做一次 `stat`；期间被追加/改写则丢弃本次结果，稳定性计数归零，下一轮重试。
- 事件监听 + 轮询兜底：目录被删除、重建、或事件丢失时，轮询会恢复；目录重新出现后自动重新挂载监听。
- 文件从目录消失会标记 `missing` 并出现在批次日志里；重新出现时计为「恢复」（`recovered`）。

### 2. 原文哈希与幂等

- 每份文件入库前计算 SHA-256，原文归档在 `data/archive/<前两位>/<hash>.<ext>`，写入用临时文件 + rename。
- **字节完全相同** → 记为 `duplicate`，引用已有文档，不新建、不覆盖。
- **字节不同但业务键相同**（解析器 + 发票号 + 开票日期）→ `business_duplicate` 隔离项，同样不覆盖。
- 同一路径内容被修改 → 是新接入；原文档保持原状。

### 3. 解析器与版本

| key | 供应商 | 通道 | v1 → v2 差异（演示用） |
|---|---|---|---|
| `acme-ubl` | ACME Industrial GmbH | XML (UBL) | v2 missing `PayableAmount` 时回退 `TaxInclusiveAmount` |
| `acme-pdf` | ACME Industrial GmbH | PDF | v2 读取发票日期（v1 取页面首个日期）；识别 credit note |
| `nordwind-xml` | Nordwind Handels AG | XML | v2 支持 `CostCenter` 两种写法 |

- 每次解析都写入 `parse_runs`，包含 `parser_key`、`parser_version`、字段、校验结果、差异和触发方式（`watch` / `replay`）。
- 解析器版本持久化在 `parser_versions`，重启后保持。
- 页面上切换版本会按配置自动重放全量历史；也可在「重放」里指定版本单独执行。

### 4. 重放

- 从归档读回原始字节，**先校验 SHA-256 与文档记录一致**，不一致则 `integrity_error`，不解析。
- 使用**目标版本**解析（不是当前激活版本），与文档基线 run 逐字段比较。
- 结果分类：`updated` / `recovered` / `unchanged` / `quarantined` / `confirmed_match` / `confirmed_drift` / `parse_failed` / `integrity_error`。
- 重放修复了隔离项会以 `replay_fixed` 自动关闭原隔离项。

### 5. 已确认结果不可覆盖

- `documents.state = confirmed` 后，字段来自 `confirmed_fields_json`。
- 重放对已确认文档**只比较**：一致则 `confirmed_match`，不一致、甚至解析失败，都只开 `confirmed_drift` 隔离项，`fields_json` / `confirmed_fields_json` / `parser_version` 均不变。
- 重复文件、业务重复、后续同路径修改都不会改动已确认文档。
- API 层再次确认返回 409；确认后的文档不允许拒绝。

### 6. 人工隔离队列

| kind | 触发 |
|---|---|
| `validation` | 字段缺失、日期非法、金额不一致、行金额异常 |
| `confirmed_drift` | 重放结果与已确认字段不一致 |
| `business_duplicate` | 同一业务键、不同字节 |
| `corrupt_file` | XML 非良构 / 空文件 / XXE 等 |
| `unknown_supplier` | 没有匹配的供应商规则 |
| `unreadable_pdf` | 加密、损坏、无文本层（扫描件） |
| `unsupported_file` | 扩展名不在监控内，或文件超过 50 MB 上限 |
| `replay_failed` | 重放执行异常 |

同一文档的同类问题不会重复堆积（刷新现有项）。修复后的文件重新接入时，原文件级隔离项会以 `superseded` 自动关闭。处理动作：接受并确认、标记已处理、重新打开。

## 页面

| 标签 | 内容 |
|---|---|
| 总览 | 关键指标、近 14 天接入结果（堆叠柱状图，悬停/键盘可读）、最近批次、隔离分布、解析器版本、最近重放 |
| 文件批次 | 每次扫描的文件级结果：入库 / 隔离 / 重复 / 等待稳定 / 缺失 / 忽略，含哈希与说明 |
| 发票 | 搜索与状态筛选，打开抽屉查看字段、重放差异、校验错误、解析历史、接入尝试、原文与版本 |
| 人工隔离 | 按状态/类型筛选，查看原因（含金额差额明细）、处理动作 |
| 重放 | 全部重放任务与逐份发票的前后变化 |
| 解析器 | 版本切换（自动重放）与当前版本 |
| 事件日志 | 扫描、缺失、恢复、升级、确认、重放等事件；目录文件状态 |

## API

```
GET  /api/health
GET  /api/overview
GET  /api/batches                     ?limit&before
GET  /api/batches/:id
GET  /api/documents                   ?state&supplier&q&limit&offset
GET  /api/documents/:id               → document, runs, intakes, quarantine, source_file
GET  /api/documents/:id/export
POST /api/documents/:id/confirm       {by,note,fields?}
POST /api/documents/:id/reject        {by,note}
GET  /api/quarantine                  ?status&kind&limit
GET  /api/quarantine/:id
POST /api/quarantine/:id/resolve      {resolution,by,note}
POST /api/quarantine/:id/reopen
POST /api/quarantine/:id/confirm-document
GET  /api/parsers
POST /api/parsers/:key/version        {version}   → 切换并自动重放
GET  /api/replays                     ?limit
GET  /api/replays/:id
POST /api/replays                     {parserKey,toVersion,fromVersion?,documentIds?}
POST /api/scan                        {trigger,force?}
GET  /api/events                      ?limit&kind
GET  /api/source-files                ?status&limit
GET  /api/intakes/:id
```

## 配置

复制 `.env.example` 为 `.env`（启动时自动读取），或直接用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 4477 | HTTP 端口 |
| `WATCH_DIR` | `./inbox` | 监控目录 |
| `DATA_DIR` | `./data` | 数据库与原文归档 |
| `DB_FILE` | `<DATA_DIR>/intake.db` | 可单独指定数据库文件 |
| `SETTLE_MS` | 1200 | 最后写入后需静置多久才读取 |
| `POLL_MS` | 2000 | 轮询兜底间隔 |
| `MAX_FILE_BYTES` | 52428800 | 超过即隔离，不读入内存 |

## 目录结构

```
src/
  lib/        xml.js（无 DTD 的 XML 读取）· pdf.js（文本抽取）· pdfgen.js（测试用 PDF）
              util.js（金额整数分/哈希）· validate.js（校验规则）· diff.js（字段差异）
  parsers/    供应商规则与版本目录 · state.js（持久化激活版本）
  ingest/     scanner.js（扩展名/稳定判定）· watcher.js（事件+轮询）
  engine/     engine.js（接入、哈希、去重、隔离、确认、重放）
  server/     app.js（HTTP API + 静态文件）· queries.js（读取模型）· index.js（启动）
public/       原生前端（index.html / app.js / lib.js / styles.css）
scripts/      seed-demo.js · fixtures/*
test/         parsing · engine · intake · api（node:test）
```

## 设计取舍

- **零依赖**：金额用整数分存储，XML 解析器拒绝 DOCTYPE（XXE / entity expansion），PDF 抽取只处理文本层，扫描件明确隔离而不是产出空字段。
- **不可信输入有边界**：文件超过 50 MB 在读入内存前就被拒绝并进入隔离；XML 限制 8 MB / 200 层嵌套；PDF 单个解压流上限 16 MB、抽取文本上限 2 MB（防压缩炸弹）。
- **金额校验**：`净额 + 税额 = 含税总额`，允许 1 分容差（供应商独立四舍五入）；行金额汇总与净额不一致只记警告。
- **隔离去重**：同文档同类问题刷新而非新增，避免轮询导致队列膨胀；直接接入（无文件记录）时按内容哈希去重。
- **重放基线**：已确认文档以确认值做比较基线，未确认文档以 `accepted_run_id` / `latest_run_id` 为基线，差异随 run 持久化，事后可审计。
- **人工改写也校验**：确认时提交的字段覆盖会与解析结果合并后重新跑校验，非法覆盖返回 400；未知字段被丢弃，避免任意 JSON 进入确认记录。
- **停机安全**：SIGINT/SIGTERM 先停止监听、等待进行中的扫描结束，再关闭数据库；重启首轮扫描会补齐停机期间落下的文件。
