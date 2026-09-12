# 服务端权威的多步骤网页办理流程（含可核验电子回执）

一个可 Docker 部署的参考实现：每一步都必须由服务端确认；浏览器地址、后退、直接调接口、令牌重放、跨页面使用、网络重试或并发提交都不能跳过步骤或重复生成确认。四步全部确认成功后，系统生成唯一回执编号与核验码的**电子回执**，内容固定、可下载打印、可免登录核验，且不能被退回修改或覆盖；任何更正都会产生一条全新的办理记录与新回执。

## 演示账号

- `alice` / `password123`
- `bob` / `password123`
- `carol` / `password123`
- `dave` / `erin`（回执功能测试账号，密码相同）

可通过环境变量 `DEMO_PASSWORD` 修改演示密码。生产环境应替换为正式的用户目录、密码轮换和 HTTPS。

## 本地运行

```bash
npm install
npm start
# 办理入口 http://localhost:3000
# 免登录核验 http://localhost:3000/verify
```

自动测试：

```bash
npm test
```

## Docker 部署

```bash
docker compose up -d --build
```

数据位于 Docker volume `wizard-data`，容器重启后以下状态均保留：

- 进行中的办理和服务端当前步骤
- 每一步的已确认内容和确认时间
- 当前步骤未完成草稿
- 会话、一次性令牌的已使用/已撤销/过期状态
- 提交幂等记录和审计事件
- **全部电子回执（固定快照、状态、撤销留档）**
- **回执核验码密钥 `receipt-secret.key`（核验能力依赖它，务必随数据卷备份）**

默认监听 3000。若由反向代理终止 HTTPS，请设置：

```yaml
COOKIE_SECURE: "1"
```

也可通过 `RECEIPT_SECRET` 显式提供固定密钥（建议使用编排平台的密钥管理）；未提供时系统会在数据目录自动生成权限 `0600` 的密钥文件。**密钥丢失将导致已签发回执的核验码无法再核验。**

## 业务流程

1. 申请人信息
2. 联系地址
3. 办理事项
4. 确认声明

每个用户可以有多条办理记录：第一条由首次办理产生；此后每次“更正”都会再产生一条。`workflows.progress` 是唯一权威当前步骤，前端只能展示和提交该步骤；服务端不提供任何“跳到第 N 步”的推进接口。

## 电子回执语义

### 1. 唯一编号与核验码，只在四步全部确认成功时生成

- 回执编号格式 `HZ-YYYYMMDD-XXXXXXXX`（Crockford Base32，无易混字符，唯一约束，冲突重试）。
- 核验码 8 位（展示为 `XXXX-XXXX`），由服务端密钥对编号做 HMAC-SHA256 确定性派生，**数据库不存核验码**，只在办理人视图展示，与编号提示“分开保管”。
- 回执与完成动作在同一个 `BEGIN IMMEDIATE` 事务中生成；编号唯一索引保证只有一份。

### 2. 内容固定保存（快照）

`receipts.snapshot_json` 在签发瞬间冻结，包含：

- 各步已确认信息（原始申报内容）
- 各步确认时间
- 最终完成时间
- 回执编号、签发时间、办理序号

此后办理记录、令牌、草稿的任何变化都不会改动该快照；快照行只能被撤销（改状态），没有任何更新内容的接口。

### 3. 刷新、重新登录、服务重启后仍是同一份；网络重试不产生第二份

- 回执按 `workflow_id` 唯一；签发逻辑先查已存在回执再插入，任何并发/重试路径都拿到同一行。
- 最后一步的网络重试复用同一 `idempotencyKey` 时命中幂等回放（`replay: true`），返回原提交与原回执；令牌已消费的重放返回 `TOKEN_USED`。两者都不会产生第二份回执。
- 回执与密钥都在 SQLite/数据卷中，进程或容器重启后编号、核验码、内容完全一致。

### 4. 下载与打印

- 登录后 `GET /api/receipts/{编号}/print` 返回自包含、带“已完成”状态标识（印章式角标）的可打印 HTML，含打印按钮与 `@media print` 样式，可直接打印或另存 PDF，`Cache-Control: no-store`。
- 本人文档含完整申报内容；他人或未登录访问返回 401/404。

### 5. 免登录核验（只展示脱敏信息）

页面 `GET /verify`；接口 `POST /api/verify`，必须同时提供回执编号与核验码：

| 情况 | HTTP | 错误码 |
| --- | --- | --- |
| 编号不存在 | 404 | `RECEIPT_NOT_FOUND` |
| 核验码错误 | 403 | `VERIFY_CODE_INVALID` |
| 回执已撤销 | 410 | `RECEIPT_REVOKED` |
| 输入格式不正确 | 400 | `INVALID_INPUT` |
| 尝试过频 | 429 | `TOO_MANY_REQUESTS` |

核验成功仅返回：**脱敏姓名、脱敏手机号、办理事项、最终完成时间**。

- 姓名：保留首尾，如 `张*丰` / `欧**娜` / `王*`
- 手机号：`138****8000`
- 证件号码、完整地址（省市区/详细地址）在任何公开响应字段与公开文档中都不出现（测试中对整段响应做了敏感串断言）
- 接口按来源 IP 做滑动窗口限流（默认 15 分钟 20 次，可用 `VERIFY_RATE_MAX` / `VERIFY_RATE_WINDOW_MS` 调整）
- 核验码比较使用恒定时间比较，编号查找做格式白名单校验

同样有一份免登录的**脱敏可打印文档**（仍需编号 + 核验码）：
`GET /api/public/receipts/{编号}/print?code=核验码`。

### 6. 已完成回执不能退回修改或被覆盖

- 完成后 `/api/rollback` 返回 `WORKFLOW_COMPLETED`，任何步骤的确认内容与确认时间都不能再改。
- 令牌领取、草稿保存、步骤提交在完成后同样被拒绝；服务端不会重新打开已完成的记录。
- 撤销（办理人 `POST /api/receipts/{编号}?action=revoke`）只把状态改为 `revoked` 并记录撤销时间/原因与审计事件：内容仍固定留档，公开核验明确提示“已撤销（失效）”，不能恢复。

### 7. 更正必须留下新的办理记录

`POST /api/corrections { receiptNo }`：

- 原回执与原办理记录**原样冻结**（快照、确认时间、编号都不变）；
- 创建 `sequence + 1` 的新办理记录（`source_receipt_no` 指回原回执，并有审计事件），需要重新逐步确认四步；
- 新记录的各步草稿**用原回执内容预填**，办理人在此基础上修改；
- 新流程完成后生成**新的回执编号与核验码**；
- 每人至多一条进行中的办理、**同一回执至多一条进行中的更正**（两个部分唯一索引 + 事务）：两个页面同时发起时只有一个成功，另一个收到 `409 CORRECTION_IN_PROGRESS`，响应中携带最新办理与时间线，前端随即重新读取最新状态；
- “我的回执”列表永久保留历次记录，可分别查看/下载。

### 8. 回执版本时间线

`GET /api/state` 与更正相关接口的响应都携带 `timeline`：按办理顺序（`sequence` 升序）列出每次办理产生的回执、正在进行中的更正草稿，以及来源关系——

- 回执条目：`receiptNo`、`status`（`issued`/`revoked`）、`sourceReceiptNo`（更正自哪份回执）、`correctedBy`（被哪份回执/更正草稿更正）；
- 更正草稿条目：`kind: 'correction'`、`status: 'in_progress'`、当前步骤与 `sourceReceiptNo`；
- 关系完全由 `workflows.source_receipt_no` 派生，该字段创建后不再改变，因此**新回执签发后，旧回执的内容、核验结果与时间线关系都保持不变**。

### 9. 更正预览（字段级差异，敏感字段遮罩）

发起更正后、提交任何新步骤前，页面都会展示原回执与当前草稿的字段级差异（`GET /api/corrections/preview`，也随 `/api/state` 的 `correction` 字段下发）：

- 每个字段标注 **新增 / 修改 / 删除 / 未变更**，并附汇总计数；
- 差异在服务端计算；**证件号码与详细地址只下发遮罩内容**（如 `ID*********23`、`西湖******`），原始值不出现在任何预览响应中；
- 草稿每次保存、每一步确认后预览自动刷新；草稿持久化在 SQLite 中，刷新、重新登录或服务重启后更正草稿与预览差异都保留。

### 10. 放弃更正

`POST /api/corrections?action=abandon`：删除更正产生的新办理记录及其草稿/令牌/提交，**原回执的内容、状态与核验结果完全不受影响**；放弃后可基于原回执重新发起更正。非更正的首次办理不能通过该接口关闭（`NOT_A_CORRECTION`）。

## 关键安全语义（原流程）

### 服务端以当前进度为准

- `POST /api/tokens` 只为 `workflows.progress` 对应步骤发令牌。
- `POST /api/submissions` 在数据库事务中再次检查令牌步骤和当前步骤。
- 前端没有可影响服务端进度的 URL 参数；刷新、后退或手工调用后续接口都会得到 409，并返回服务端当前进度。
- 草稿也只能保存到服务端当前步骤。

### 一次性、短期、强绑定令牌

256 位随机值，数据库只存 SHA-256 哈希，绑定用户、办理记录、登录会话、页面实例 ID、步骤与过期时间（默认 10 分钟，`TOKEN_TTL_MS`）。成功后立即 `used_at`，其他页面未使用令牌同事务撤销。错误码：`TOKEN_USED` / `TOKEN_EXPIRED` / `TOKEN_STEP_MISMATCH` / `TOKEN_PAGE_MISMATCH` / `TOKEN_SESSION_MISMATCH` / `STEP_NOT_CURRENT` / `CONCURRENT_PROGRESS_CHANGED` / `PROGRESS_MOVED`。

### 网络刷新/重试不重复推进

每次确认生成 `idempotencyKey`，`(workflow_id, idempotency_key)` 唯一约束，事务内：锁写事务 → 幂等检查（回放优先，保证最后一步完成后的重试仍返回同一结果）→ 校验消费令牌 → 写确认 → 推进进度 → 末步同事务签发回执。

### 两个页面并发提交

`BEGIN IMMEDIATE` 串行化：一个成功，另一个看到进度变化或令牌已撤销，返回 409、原因和最新进度。

### 退回修改（仅完成前）

目标步骤及之后的确认清空、内容保留为草稿、未使用令牌撤销、进度回退；完成后此接口被禁用，只能走“更正”。

## API 摘要

| 方法 | 路径 | 登录 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/login` | 否 | 登录，创建 HttpOnly 会话和 CSRF Cookie |
| POST | `/api/logout` | 是 | 退出 |
| GET | `/api/state` | 是 | 当前办理（工作流+回执）、历史回执清单、版本时间线与更正预览 |
| POST | `/api/tokens` | 是 | 为当前步骤领取一次性令牌 |
| POST | `/api/drafts` | 是 | 保存当前步骤草稿 |
| POST | `/api/submissions` | 是 | 校验令牌并原子确认当前步骤（末步签回执） |
| POST | `/api/rollback` | 是 | 退回已确认步骤（完成后禁用） |
| GET | `/api/receipts` | 是 | 我的回执清单 |
| GET | `/api/receipts/{no}` | 是 | 回执完整数据（本人） |
| GET | `/api/receipts/{no}/print` | 是 | 完整可打印回执 HTML |
| POST | `/api/receipts/{no}?action=revoke` | 是 | 撤销回执（只改状态、留档） |
| POST | `/api/corrections` | 是 | 基于某回执发起更正（新建办理记录，草稿用原回执预填） |
| GET | `/api/corrections/preview` | 是 | 原回执 vs 当前更正草稿的字段级差异（敏感字段遮罩） |
| POST | `/api/corrections?action=abandon` | 是 | 放弃进行中的更正（原回执不受影响） |
| POST | `/api/verify` | 否 | 编号+核验码核验，仅返回脱敏结果，按 IP 限流 |
| GET | `/api/public/receipts/{no}/print?code=` | 否 | 脱敏可打印回执文档 |
| GET | `/verify` | 否 | 免登录核验页面 |

所有非 GET 的登录态接口要求 `X-CSRF-Token`。会话 Cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 环境可启用 `Secure`。

## 存储模型

- `workflows`：多条记录（`sequence`、`status`、`source_receipt_no`），部分唯一索引保证每人至多一条 `open`、同一回执至多一条进行中的更正
- `workflow_steps.draft_json / confirmed_json / confirmed_at`：草稿与服务端确认
- `receipts`：回执编号（唯一）、固定快照、状态（`issued`/`revoked`）、撤销时间与原因
- `tokens`：令牌哈希、绑定维度、过期、使用、撤销状态
- `submissions`：幂等键、请求指纹、提交和确认结果
- `events`：创建、草稿、确认、退回、签发回执、撤销、更正创建等审计事件

SQLite 启用 WAL 和外键；所有推进与回执签发都在同步 `BEGIN IMMEDIATE` 事务中完成。首次用新版启动旧版数据库时会自动迁移表结构并为已完成记录补签回执。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DB_PATH` | `data/wizard.db` | SQLite 路径 |
| `TOKEN_TTL_MS` | `600000` | 令牌有效期 |
| `SESSION_TTL_MS` | `43200000` | 会话有效期 |
| `COOKIE_SECURE` | `0` | HTTPS 下设为 `1` |
| `DEMO_PASSWORD` | `password123` | 演示账号密码 |
| `RECEIPT_SECRET` | 空 | 核验码 HMAC 密钥；空则用密钥文件 |
| `RECEIPT_SECRET_PATH` | `data/receipt-secret.key` | 自动生成的密钥文件路径（0600） |
| `VERIFY_RATE_MAX` | `20` | 单 IP 限流窗口内最大核验次数 |
| `VERIFY_RATE_WINDOW_MS` | `900000` | 限流窗口长度 |
| `DISPLAY_TIMEZONE` | `Asia/Shanghai` | 回执文档时间展示时区 |
