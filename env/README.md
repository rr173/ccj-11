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
- **复核邀请、免登录复核会话、字段异议与处理结果、异议→更正→新回执来源关系**
- **多方复核批次：批次状态、2-5 个限时一次性邀请、逐邀请字段授权、逐字段阈值、合并字段意见、逐字段决议与“接受意见→同一份更正→新回执”来源关系**
- **分阶段复核编排：阶段顺序与状态、每阶段邀请/字段范围与阈值、开始时冻结的超时策略与倒计时、超时落定结果、编排配置版本与完整变更历史**
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

若被放弃的更正回应了已接受的复核异议，这些异议会自动回到“待处理”，可再次接受或驳回。

## 回执复核协作

办理人可在**已签发回执**上发起限时、一次性的复核邀请；复核人**无需登录**，完成邀请校验后只能查看链接绑定的那一份回执的**脱敏内容**，并针对具体字段提交异议。办理人逐条接受或驳回：接受必须进入一次新的更正办理，驳回必须保留理由。

### 1. 限时、一次性、强绑定单份回执的邀请

- `POST /api/reviews/invitations { receiptNo, ttlMinutes }`（登录态）只允许回执本人创建；有效期默认 1 小时～7 天（`REVIEW_INVITE_MIN_TTL_MS` / `REVIEW_INVITE_MAX_TTL_MS`，默认 3 天）。
- 邀请令牌为 256 位随机值，数据库只存 SHA-256 哈希；链接形如 `/review?t=…`，完整令牌只在创建当次返回一次（与核验码同等对待）。
- **只能使用一次**：`POST /api/review/validate` 在一个 `BEGIN IMMEDIATE` 事务中把邀请置为 `used` 并创建复核会话；再次使用同链接明确失败：

| 情况 | HTTP | 错误码 |
| --- | --- | --- |
| 令牌不存在/格式错误 | 404/400 | `INVITATION_NOT_FOUND` / `INVALID_INVITATION` |
| 邀请已过期 | 410 | `INVITATION_EXPIRED` |
| 邀请已被办理人撤销 | 410 | `INVITATION_REVOKED` |
| 链接已被使用过（重复校验） | 410 | `INVITATION_ALREADY_USED` |
| 回执已撤销 | 410 | `RECEIPT_REVOKED` |
| 校验尝试过频 | 429 | `TOO_MANY_REQUESTS` |

- 办理人可在邀请使用前撤销（`POST /api/reviews/invitations/{id}/revoke`）；撤销后即使复核人已打开页面，后续查看与提交也立即失效。已使用的邀请不能撤销（`INVITATION_ALREADY_USED`）。
- 校验接口按来源 IP 滑动窗口限流（复用核验限流参数）。

### 2. 免登录复核会话：只看这一份回执的脱敏内容

- 校验成功后下发 HttpOnly 会话 Cookie（`rid`，数据库仅存哈希）与独立 CSRF Cookie（`rcsrf`），有效期不超过邀请有效期；刷新页面、重新打开浏览器、服务重启后会话仍保留（持久化在 SQLite）。
- `GET /api/review/context` 只返回**会话绑定的那一份回执**的脱敏视图：姓名/手机号/证件号码/详细地址全部遮罩（脱敏在服务端完成，响应中不出现原值）；没有会话或会话随邀请过期/撤销时一律 `401 REVIEW_SESSION_REQUIRED`。
- 复核会话无法用于查看其他回执：任何提交若携带其他回执编号，返回 `403 REVIEW_RECEIPT_MISMATCH`；系统本身不提供任何按编号查询他人/他份回执的免登录接口。
- 写接口（提交异议）要求复核会话自带的双提交 CSRF，缺失返回 `403 REVIEW_CSRF_INVALID`。

### 3. 字段级异议：状态、提交时间、处理人与处理结果全部留档

- `POST /api/review/objections { step, field, reason, idempotencyKey }`：字段必须是该回执真实步骤中的字段（否则 `INVALID_FIELD`），说明 2-500 字（`INVALID_REASON`）；提交时记录脱敏字段值快照、提交时间。
- 网络重试复用同一 `idempotencyKey` 且请求指纹一致时返回同一条异议（`replay: true`）；同一编号换内容重放返回 `409 OBJECTION_DUPLICATE_KEY`。
- 异议状态机：`open → accepted | rejected`，记录 `resolvedAt`、处理人（`resolvedBy`）、处理结果；驳回理由（2-200 字）持久化保存（`REJECT_REASON_REQUIRED`）。
- **同一条异议不能被两个页面同时处理**：处理前可先 `POST …/lock` 取得 60 秒咨询锁（另一会话得到 `OBJECTION_LOCKED_BY_OTHER`）；终局的接受/驳回在写事务中以 `status='open'` 为唯一判定条件，两个会话并发终局决定只有一个成功，另一个得到 `409 OBJECTION_ALREADY_HANDLED` 并返回**同一条已存在的结果**，前端明确显示“已处理”。

### 4. 接受异议必须进入新的更正办理，原回执不被覆盖

- 接受（`POST …/{id}/accept`）在同一事务内：异议置为 `accepted` + 复用既有“同源进行中更正”或创建一条 `source_receipt_no` 指向该回执的新更正办理（草稿用原回执预填），并通过 `correction_objections` 留下来源关联。
- 已有进行中的**其他**办理时接受明确失败（`409 OPEN_WORKFLOW_EXISTS`）。
- 更正完成签发新回执时，新回执编号回填到异议（`correctionReceiptNo`）；原回执快照、核验码、核验结果始终不变。
- 放弃更正会把关联的已接受异议重新置为 `open`，可再次处理。

### 5. 持久化与时间线

- 邀请、复核会话、异议、处理结果与关联全部存入 SQLite（`review_invitations` / `review_sessions` / `review_objections` / `correction_objections`），刷新、重新登录或服务重启后保留；审计事件（`review.invitation.created/consumed/revoked`、`review.objection.submitted/accepted/rejected/reopened`、`review.correction.completed`）写入回执对应办理记录。
- `/api/state` 时间线在对应回执之后插入 `kind: 'review'` 条目：邀请状态（待使用/已使用/已撤销/已过期）、异议数量、每条异议的字段、说明、提交时间、处理结果，以及“接受异议 → 更正办理 → 新回执”的来源关系；更正完成后条目直接展示新回执编号。
- 办理人界面：回执卡片下方“回执复核协作”面板可创建邀请、复制/撤销链接、逐条接受/驳回；时间线条目内也可直接处理。复核人界面：`GET /review` 展示脱敏字段（每个字段可一键发起异议）、异议提交表单与本人异议的处理结果。


## 分阶段复核编排（staged orchestration）

在多方复核批次之上，办理人可以把一个批次拆成**按顺序执行的多个阶段**：

- 每个阶段独立配置**邀请范围**（1-5 个一次性邀请，整批合计 2-5 个）、**字段范围**（字段在整个批次内不可跨阶段重复）、**接受/驳回阈值**、**阶段限时**与**超时策略**。
- 阶段严格顺序开放：前一阶段未达到终局条件（全部字段决议完成，或按冻结策略落定）时，后续阶段不能校验邀请、查看字段或提交意见（`BATCH_STAGE_NOT_STARTED`）。
- **超时策略三选一，且在阶段开始时冻结**（`frozen_policy`），阶段开始后修改编排不影响进行中的阶段：
  - `advance`：自动转入下一阶段——本阶段未决字段由系统自动驳回（标记 `timeout_advance`，理由留档），随后激活下一阶段并起算其倒计时；最后一阶段则批次完成。
  - `revoke_unused`：撤销本阶段尚未使用的邀请，阶段进入收尾，复核人不能再提交；办理人仍须依据已收集的意见（阈值分母只计已校验且未撤销的邀请）完成剩余字段决议后才开放下一阶段。
  - `fail`：批次标记为**超时失败**（`timed_out` 终态），撤销全部未使用邀请、会话失效；已提交的意见与已决字段原样留档。
- 超时落定同时由后台定时器（默认每 5 秒扫描，`BATCH_TIMEOUT_SWEEP_MS`）、服务启动恢复扫描与各接口的惰性检查触发；以 `timeout_fired_at IS NULL` 的条件更新为唯一判定，**重复触发不产生第二次结果**。
- **编排版本号（乐观锁）**：批次配置带 `configVersion`。在任何阶段开始前，办理人可携带 `expectedVersion` 调整编排；两个页面同时基于同一版本保存时只有一个成功，另一个收到 `BATCH_CONFIG_VERSION_CONFLICT` 并返回最新版本与批次状态。任何阶段一旦开始，其配置即冻结，重配返回 `BATCH_CONFIG_LOCKED`。
- 已提交的字段意见**不会因阶段切换而被改写**；放弃由接受意见进入的更正办理时，相关字段决议回收，对应阶段回到可决议状态。
- 时间线的批次条目包含：阶段事件、配置版本、每阶段最终决议（`finalDecision`）、倒计时截止与超时结果、逐字段意见/阈值进度、更正回执来源，以及完整配置变更历史（`changeHistory` 与逐版本 `config_json`）。
- 分阶段批次创建后处于 `collecting`，需办理人显式“启动第一阶段”才开始倒计时与冻结策略；启动前可凭版本号反复调整编排。

## 多方复核批次（可配置的多方复核与决议编排）

办理人可在**已签发回执**上创建一个多方复核批次：同一份回执配 2～5 个**限时、一次性**邀请，每个邀请有独立的**可查看字段范围**，批次对每个纳入编排的字段配置**接受阈值 / 驳回阈值**。批次只有在全部邀请完成一次性校验后才能进入复核；复核人只能针对**本邀请被授权的字段**提交意见；同一字段的多份意见**合并展示但逐字保留每位复核人的原始说明**；办理人逐字段作出接受或驳回决议时**必须满足对应阈值**；被接受字段的全部意见进入**同一份**新的更正办理并关联全部意见。

### 1. 批次配置与状态

- `POST /api/review-batches`（登录态，仅回执本人）：
  - `invitations`：2～5 个，每个含 `label` 与 `fields`（本邀请可查看/可评价的字段 key 列表，如 `0.phone`）；
  - `fields`：纳入编排的字段与阈值，每个字段 `acceptThreshold` / `rejectThreshold` 均为 1～邀请数之间的整数；
  - 邀请的字段授权必须是批次编排字段的**子集**，且每个编排字段至少被一个邀请授权（否则 `INVALID_BATCH_FIELD` / `INVALID_BATCH_FIELD_SCOPE`）；
  - 同一回执至多一个未终结批次（并发创建只有一个成功：`409 BATCH_ALREADY_OPEN`）。
- 批次状态机：`collecting → in_review → completed`，另有终态 `cancelled`：
  - **门控**：最后一个邀请校验成功时自动进入复核；办理人也可显式 `POST …/{batchId}/start`，未全部校验时明确失败（`BATCH_GATE_NOT_SATISFIED`，响应给出未校验邀请）；有邀请被撤销/过期时门控不可恢复（`BATCH_GATE_INVITATION_INVALID`），只能取消批次重建；
  - 全部字段都有终局决议后批次自动 `completed`；批次在进入复核前、或复核中但**尚无任何决议**时可取消（`POST …/{batchId}/cancel`，可带理由）；已有字段决议后取消明确失败（`BATCH_HAS_DECISIONS`）。
- 批次邀请链接形如 `/batch-review?t=…`，完整令牌同样只在创建当次返回（每个邀请一条一次性链接）。
- **分阶段批次**：创建请求用 `stages: [{ name, ttlMinutes, timeoutPolicy, fields: [{ key, acceptThreshold, rejectThreshold }], invitations: [{ label, fields }] }]`（1-5 个阶段、整批 2-5 邀请）代替顶层 `fields/invitations/ttlMinutes`。创建后需 `POST …/{batchId}/start` 启动第一阶段；阶段全部未开始前可用 `POST …/{batchId}/orchestration`（带 `expectedVersion`）整体重配。

### 1b. 分阶段编排的配置版本与阶段门控

- `POST /api/review-batches/{id}/orchestration`（登录态）：仅当批次所有阶段都还 `pending`（未开始、无邀请校验）时允许整体替换编排；必须携带与当前 `configVersion` 一致的 `expectedVersion`，否则 `409 BATCH_CONFIG_VERSION_CONFLICT`（响应带最新 `batch`）。并发重配以 `UPDATE … WHERE config_version = ?` 保证只有一个成功，成功后版本 +1、旧邀请令牌全部失效、返回一组新一次性链接。
- 任何阶段一旦开始即冻结：重配返回 `409 BATCH_CONFIG_LOCKED`；撤销已开始阶段的邀请也被拒绝。
- 阶段门控：校验/查看/提交后续阶段邀请，在其阶段 `pending` 时返回 `409 BATCH_STAGE_NOT_STARTED`；阶段结束后返回 `410 BATCH_STAGE_NOT_CURRENT`；阶段限时已过返回 `410 BATCH_STAGE_DEADLINE_PASSED`；批次超时失败后所有写操作返回 `BATCH_STAGE_TIMED_OUT`。
- `GET /api/review-batches/{id}/history`：返回当前 `configVersion`、逐版本配置快照（`versions[].config`）与变更历史（`history[]`：创建、重配、阶段开始/完成/超时、取消、批次完成）。

### 2. 限时一次性邀请与字段授权

- 邀请 256 位随机令牌、数据库只存 SHA-256 哈希；`POST /api/batch-review/validate` 在 `BEGIN IMMEDIATE` 事务内把邀请置为 `used` 并建立独立的免登录批次会话（Cookie `bid` + CSRF `bcsrf`，有效期不超过邀请有效期）。

| 情况 | HTTP | 错误码 |
| --- | --- | --- |
| 令牌不存在/格式错误 | 404/400 | `BATCH_INVITATION_NOT_FOUND` / `INVALID_INVITATION` |
| 邀请已过期 / 批次已取消 | 410 | `BATCH_INVITATION_EXPIRED` / `BATCH_INVITATION_REVOKED` |
| 邀请被办理人撤销 | 410 | `BATCH_INVITATION_REVOKED` |
| 链接已被使用过（重复校验） | 410 | `BATCH_INVITATION_ALREADY_USED` |
| 回执已撤销 | 410 | `RECEIPT_REVOKED` |
| 校验尝试过频 | 429 | `TOO_MANY_REQUESTS` |

- 办理人可在邀请使用前撤销单个邀请（`POST /api/review-batches/invitations/{id}/revoke`）；已使用不能撤销（`INVITATION_ALREADY_USED`）。
- **复核页面与接口只返回本邀请被授权的字段**：`GET /api/batch-review/context` 的脱敏视图按字段授权过滤，未授权字段整列不出现；敏感字段（证件号码、详细地址）即使被授权也只下发遮罩值。携带其他回执编号提交得 `403 BATCH_RECEIPT_MISMATCH`。
- **越权字段提交明确失败**：对未授权字段提交意见返回 `403 BATCH_FIELD_NOT_AUTHORIZED`；每个邀请对每个授权字段至多提交一份意见（重复得 `409 BATCH_FIELD_DUPLICATE_OPINION`，UNIQUE 约束兜底并发）。
- 提交意见支持幂等键（同键同指纹回放同一条，换指纹得 `OBJECTION_DUPLICATE_KEY`）。

### 3. 逐字段决议编排（阈值门控 + 并发安全 + 同一份更正）

- 办理人侧 `POST /api/review-batches/{batchId}/fields/{fieldId}/accept|reject`：
  - 批次必须处于 `in_review`（否则 `BATCH_GATE_NOT_SATISFIED`）；字段必须属于本批次；
  - **接受**：对该字段提出意见的**不同复核人数**必须达到 `acceptThreshold`（否则 `ACCEPT_THRESHOLD_NOT_MET`）；
  - **驳回**：已完成校验且未撤销的复核人中，**未对该字段提出意见的人数**必须达到 `rejectThreshold`（否则 `REJECT_THRESHOLD_NOT_MET`），且驳回理由 2～200 字持久化保存（`REJECT_REASON_REQUIRED`）；
  - **同一份更正**：接受在事务内复用进行中的同源更正或当场新建一条 `source_receipt_no` 指向该回执的更正办理，并把该字段的**全部意见**写入关联表；再接受其他字段复用同一份更正，不新建第二条；
  - 已有进行中的**其他**办理时接受失败（`OPEN_WORKFLOW_EXISTS`）；
  - **重复决议与两个页面并发决议**：终局更新以 `WHERE … AND decision IS NULL` 为唯一判定，重复或并发的第二个请求得到 `409 BATCH_FIELD_ALREADY_DECIDED` 与**同一条已存在的决议**（含理由、处理人、时间）。
- 被接受意见随更正完成签发时，新回执编号回填到字段与每条意见；放弃进行中的更正会把已接受字段的决议**回收为待决议**（批次从 completed 回到 in_review，可重新作出决议）。
- **原回执始终冻结**：批次、意见、决议、更正全部走新办理记录，不写 `receipts.snapshot_json`。

### 4. 合并视图、时间线与持久化

- 复核人侧字段合并视图（`GET /api/batch-review/context` 的 `merged`）：按字段聚合所有复核人意见，标注哪条是“我的意见”，附该字段的接受/驳回阈值、当前意见数、办理人决议、驳回理由与后续更正回执编号。
- 办理人侧时间线在对应回执之后插入 `kind: 'reviewBatch'` 条目：批次事件（创建/进入复核/完成/取消/邀请校验与撤销）、每个邀请的状态与字段授权、逐字段阈值与逐字段决议（处理人、理由、时间）、合并后的全部意见（每位复核人的原始说明），以及“接受意见 → 更正办理 → 新回执”的来源关系。
- 全部状态（批次、邀请、字段授权、意见、阈值、处理人、决议、意见→更正关联）都在 SQLite 中，刷新、重新登录或服务重启后保留；批次复核会话同样持久化。

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
| POST | `/api/corrections?action=abandon` | 是 | 放弃进行中的更正（原回执不受影响；关联异议回到待处理） |
| POST | `/api/reviews/invitations` | 是 | 创建限时、一次性的复核邀请（返回一次性链接） |
| GET | `/api/reviews/invitations?receiptNo=` | 是 | 复核邀请清单（含各邀请下异议与处理结果） |
| POST | `/api/reviews/invitations/{id}/revoke` | 是 | 撤销未使用的复核邀请（已使用不可撤销） |
| GET | `/api/reviews/objections?receiptNo=` | 是 | 字段异议清单（状态、提交时间、处理人、处理结果） |
| POST | `/api/reviews/objections/{id}/lock` | 是 | 咨询锁：占位处理该异议（60 秒） |
| POST | `/api/reviews/objections/{id}/accept` | 是 | 接受异议：进入/复用同源更正办理 |
| POST | `/api/reviews/objections/{id}/reject` | 是 | 驳回异议（必须提供理由） |
| POST | `/api/review/validate` | 否 | 一次性邀请校验，成功后建立免登录复核会话 |
| GET | `/api/review/context` | 否 | 当前复核会话绑定回执的脱敏内容与本人异议 |
| POST | `/api/review/objections` | 否 | 复核人提交字段异议（需复核会话 + CSRF，幂等） |
| POST | `/api/review/logout` | 否 | 退出并清除本机会话 |
| POST | `/api/review-batches` | 是 | 创建多方复核批次（2-5 邀请、字段授权与阈值，返回一次性链接） |
| GET | `/api/review-batches` | 是 | 多方复核批次清单（可按 `receiptNo` 过滤） |
| GET | `/api/review-batches/field-options` | 是 | 可纳入批次编排的全部字段与邀请数上限 |
| GET | `/api/review-batches/{id}` | 是 | 批次详情（邀请、字段授权、合并意见、决议） |
| POST | `/api/review-batches/{id}/start` | 是 | 全部邀请校验完成后进入复核 |
| POST | `/api/review-batches/{id}/cancel` | 是 | 取消批次（进入复核后且已有决议则失败） |
| POST | `/api/review-batches/invitations/{id}/revoke` | 是 | 撤销未使用的批次邀请 |
| POST | `/api/review-batches/{id}/fields/{fieldId}/accept` | 是 | 接受字段全部意见（必须达到接受阈值，进入同一份更正） |
| POST | `/api/review-batches/{id}/fields/{fieldId}/reject` | 是 | 驳回字段意见（必须满足驳回阈值，理由必填） |
| POST | `/api/review-batches/{id}/orchestration` | 是 | 阶段开始前调整分阶段编排（乐观锁 `expectedVersion`） |
| GET | `/api/review-batches/{id}/history` | 是 | 编排配置版本快照与变更历史 |
| POST | `/api/batch-review/validate` | 否 | 批次邀请一次性校验，成功后建立批次复核会话 |
| GET | `/api/batch-review/context` | 否 | 仅本邀请授权字段的脱敏视图、合并意见与本人意见 |
| POST | `/api/batch-review/opinions` | 否 | 复核人提交字段意见（需批次会话 + CSRF，幂等） |
| POST | `/api/batch-review/logout` | 否 | 退出并清除本机批次会话 |
| POST | `/api/verify` | 否 | 编号+核验码核验，仅返回脱敏结果，按 IP 限流 |
| GET | `/api/public/receipts/{no}/print?code=` | 否 | 脱敏可打印回执文档 |
| GET | `/verify` | 否 | 免登录核验页面 |
| GET | `/review` | 否 | 免登录复核页面（先完成邀请校验） |
| GET | `/batch-review` | 否 | 免登录多方批次复核页面（先完成批次邀请校验） |

所有非 GET 的登录态接口要求 `X-CSRF-Token`。会话 Cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 环境可启用 `Secure`。

## 存储模型

- `workflows`：多条记录（`sequence`、`status`、`source_receipt_no`），部分唯一索引保证每人至多一条 `open`、同一回执至多一条进行中的更正
- `workflow_steps.draft_json / confirmed_json / confirmed_at`：草稿与服务端确认
- `receipts`：回执编号（唯一）、固定快照、状态（`issued`/`revoked`）、撤销时间与原因
- `review_invitations`：复核邀请（令牌只存哈希、有效期、`active/used/revoked/expired` 状态、使用时间/来源）
- `review_sessions`：免登录复核会话（只存令牌哈希、绑定邀请与单份回执、独立 CSRF、有效期）
- `review_objections`：字段级异议（字段、脱敏值快照、说明、`open/accepted/rejected`、提交/处理时间、处理人、驳回理由、关联更正办理与新回执编号、咨询锁、幂等键）
- `correction_objections`：已接受异议与因此进入的更正办理的多对多来源关系
- `review_batches`：多方复核批次（状态 `collecting/in_review/completed/cancelled/timed_out`、是否分阶段 `staged`、编排版本 `config_version`、超时结果、有效期、取消原因，部分唯一索引保证同一回执至多一个未终结批次）
- `review_batch_stages`：分阶段编排（顺序、名称、状态 `pending/active/completed/timed_out/failed`、限时 `duration_ms`、阶段开始时冻结的超时策略 `frozen_policy`、开始/截止/完成时间、最终决议、超时落定时间与结果）；平面批次内部归一化为唯一阶段
- `review_batch_orchestration_versions` / `review_batch_change_history`：逐版本编排配置快照（乐观锁 `review_batches.config_version`）与创建/重配/阶段开始/完成/超时/取消等变更历史
- `review_batch_fields`：批次逐字段编排（所属阶段、接受/驳回阈值）与逐字段决议（接受/驳回、理由、处理人或系统超时策略 `decided_by_policy`、时间、关联更正办理与新回执编号）
- `review_batch_invitations` / `review_batch_invitation_fields`：批次的 2-5 个限时一次性邀请（令牌只存哈希、所属阶段）与逐邀请字段授权；阶段未开始时邀请不能使用
- `review_batch_sessions`：批次邀请校验后的免登录会话（只存令牌哈希、独立 CSRF、绑定单个邀请与字段授权、有效期不超过阶段截止）
- `review_batch_opinions`：字段意见（每邀请每字段唯一，逐字保留原始说明、脱敏值快照、幂等键）；同一字段的多份意见在查询时合并。阶段超时失败/取消时会话只置为过期、不删除，避免外键级联删除需要留档的意见
- `correction_opinions`：批次字段意见/普通异议与更正办理的统一来源关联（完成更正时据此回填新回执编号、放弃更正时据此回收决议）
- `tokens`：令牌哈希、绑定维度、过期、使用、撤销状态
- `submissions`：幂等键、请求指纹、提交和确认结果
- `events`：创建、草稿、确认、退回、签发回执、撤销、更正创建、复核邀请/异议/处理等审计事件

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
| `VERIFY_RATE_MAX` | `20` | 单 IP 限流窗口内最大核验次数（复核邀请校验共用） |
| `VERIFY_RATE_WINDOW_MS` | `900000` | 限流窗口长度（复核邀请校验共用） |
| `REVIEW_INVITE_TTL_MS` | `259200000` | 复核邀请默认有效期（3 天） |
| `REVIEW_INVITE_MIN_TTL_MS` | `300000` | 复核邀请允许的最短有效期（5 分钟） |
| `REVIEW_INVITE_MAX_TTL_MS` | `604800000` | 复核邀请允许的最长有效期（7 天）；分阶段每阶段限时同样受此上下限约束 |
| `BATCH_TIMEOUT_SWEEP_MS` | `5000` | 分阶段批次超时落定后台扫描间隔；服务启动时也会先扫描一次（设 `NO_BATCH_SWEEP=1` 可关闭定时器） |
| `DISPLAY_TIMEZONE` | `Asia/Shanghai` | 回执文档时间展示时区 |
