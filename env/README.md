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
- **复核申诉回合：只能针对原批次已驳回字段发起；独立限时与一次性新邀请、逐邀请字段授权、独立接受/驳回阈值；只引用原批次冻结快照（脱敏字段+原驳回决议+显式授权并匿名化的证据摘要）；申诉意见合并/幂等、逐字段决议、“接受申诉→同一份更正→关联申诉意见与原批次来源→新回执”、取消/过期写拒绝与完整审计时间线**
- **争议调解包（两层处理）：只能从【已完成】申诉回合的驳回字段生成只读调解包，冻结原批次决议、申诉意见、授权证据与当前更正来源（原批次/申诉历史永不改写）；第一层 2-5 名新调解人独立限时意见，第一层驳回字段达到升级条件后，第二层 3-5 名仲裁人才按冻结快照开放（只能看到第一层允许披露的结论摘要与选中证据）；仲裁接受同时关联调解包、上一层结论与原批次来源进入新的更正办理，同一调解包至多一份进行中更正；取消/超时写拒绝、超时策略只落定一次、服务重启后两层关系与时间线完整（`review.mediation.*` 事件）**
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

## 复核申诉回合（traceable appeal rounds）

在多方复核批次（含分阶段批次）之上，办理人可针对**原批次已经作出驳回决议的字段**发起一次**独立的申诉回合**。申诉回合只能**引用原批次的冻结快照**：原批次的意见、决议与超时结果永远不被修改；新复核人只能看到本邀请被授权的脱敏字段、原字段的既有驳回决议与办理人显式允许披露的证据摘要（原复核人以“原复核人N”匿名化，邀请名称等未授权隐私不下发）。

- **只能针对驳回字段**：`GET /api/review-batches/{id}/appealable-fields` 只返回原批次中 `decision='rejected'`（含超时策略自动驳回）的字段；对未驳回字段发起返回 `409 APPEAL_FIELD_NOT_REJECTED`。同一字段在一个未终结回合中只能申诉一次（部分唯一索引兜底并发）。
- **独立配置**：`POST /api/review-appeals { batchId, ttlMinutes, note, fields:[{key, reason, acceptThreshold, rejectThreshold, evidenceOpinionIds}], invitations:[{label, fields}] }`
  - 申诉理由 `reason` 四选一：`new_evidence`（出现新的关键证据）/ `misjudged`（认定事实有误）/ `procedural`（程序或授权瑕疵）/ `other`；
  - **2-5 个全新的一次性邀请**，逐邀请字段授权（必须是本回合字段的子集，每个字段至少一个邀请授权）；独立的接受/驳回阈值（1..邀请数）与**独立限时**（创建即起算，默认 5 分钟～7 天）；
  - `evidenceOpinionIds` 为办理人显式允许向新复核人披露的**原批次证据意见**白名单（可空=不披露任何原证据；引用了不存在/不属于该字段的意见得 `400 INVALID_APPEAL_EVIDENCE`）；
  - 回合从创建即开放复核（独立限时起算），新复核人在限时内陆续校验、提交；同一回执/批次至多一个未终结回合，两个页面并发发起只有一个成功，另一个得 `409 APPEAL_ALREADY_OPEN`（唯一索引 + `BEGIN IMMEDIATE` 双保险）。
- **独立限时一次性邀请**：新链接形如 `/appeal-review?t=…`，独立 Cookie（`aid`/`accsrf`），令牌 256 位随机、库存哈希；校验一次性，重复使用 `410 APPEAL_INVITATION_ALREADY_USED`，过期 `410 APPEAL_INVITATION_EXPIRED`，回合取消/回执撤销分别返回 `410 APPEAL_INVITATION_REVOKED / RECEIPT_REVOKED`，校验接口按 IP 限流。
- **复核页面只展示本回合授权内容**：`GET /api/appeal-review/context` 返回授权脱敏字段（敏感值服务端遮罩）、原字段既有驳回决议（理由、时间、是否超时策略自动驳回；**不含原处理人身份**）、授权证据摘要（匿名“原复核人N”+脱敏值快照+逐字说明）与本字段申诉意见合并视图。越权读取拿不到其他字段；越权提交得 `403 APPEAL_FIELD_NOT_AUTHORIZED`；无会话/CSRF 缺失分别 `401/403`；携带他份回执编号得 `403 APPEAL_RECEIPT_MISMATCH`。
- **申诉意见按复核人合并、幂等重试**：每邀请每字段至多一份意见（重复 `409 APPEAL_FIELD_DUPLICATE_OPINION`，UNIQUE 兜底）；同一幂等键+同指纹的网络重试返回同一条意见（`replay:true`），换指纹得 `409 OBJECTION_DUPLICATE_KEY`。
- **独立阈值的逐字段决议**（办理人）：接受要求提出申诉意见的不同新复核人数 ≥ `acceptThreshold`（不足 `ACCEPT_THRESHOLD_NOT_MET`）；驳回要求“已校验且未提意见”的新复核人数 ≥ `rejectThreshold`（不足 `REJECT_THRESHOLD_NOT_MET`），且驳回理由 2-200 字持久化。终局更新以 `WHERE … AND decision IS NULL` 为唯一判定，重复/并发决议只有一个成功，另一个得到 `409 APPEAL_FIELD_ALREADY_DECIDED` 与同一条已存在结果。
- **接受必须在同一个新的更正办理中关联申诉意见与原批次来源**：接受复用进行中的同源更正或当场新建 `source_receipt_no` 指向原回执的更正；全部申诉意见写入 `correction_objections`（`appeal_opinion_id` + 显式 `source_batch_id/source_round_id`）；再接受其他字段复用同一份更正；存在进行中的**其他**办理时 `409 OPEN_WORKFLOW_EXISTS`。更正完成后新回执编号回填申诉字段与意见；放弃更正则接受决议回收为待决议（原批次驳回决议始终不变）。
- **取消与过期**：办理人可在**尚无任何字段决议**时取消（`POST /api/review-appeals/{id}/cancel`），未使用邀请立即失效、写操作全部关闭；已有字段完成决议后历史不能删除，取消得 `409 APPEAL_HAS_DECISIONS`。独立限时到达时回合整体 `expired`（后台扫描、启动恢复与接口惰性检查三路触发，条件更新保证只落定一次），之后复核人提交与办理人决议都得到 410（`APPEAL_DEADLINE_PASSED` / `APPEAL_INVITATION_EXPIRED`）；已校验会话保留只读，已提交意见原样留档；取消/过期后可对同一驳回字段重新发起回合。
- **办理人页面**展示原批次↔申诉回合关系、邀请状态、独立倒计时、证据摘要、阈值进度、处理人与逐字段决议；**回执时间线**在原批次条目之后插入 `kind: 'reviewAppeal'` 条目，区分原批次决议（`review.batch.*` 事件）、申诉事件（`review.appeal.created/started/invitation.consumed/opinion.submitted/field.accepted|rejected/cancelled/expired/completed/correction.completed`）与后续更正回执；全部状态在刷新、重新登录、服务重启后保持一致（申诉免登录会话同样持久化）。

## 争议调解包（mediation package，两层处理）

申诉回合**全部字段已决议**后，办理人可从其中的**申诉驳回字段**里选择一个或多个字段，生成一份**只读冻结调解包**。调解包只引用不修改：原批次决议、申诉意见、授权证据摘要与“当前更正来源”在生成瞬间复制冻结，之后原批次、申诉回合的任何变化都不影响调解包，调解包也绝不回写它们；未被选中的字段与未授权证据一律不进入调解包。

- **生成条件与并发**：`GET /api/review-appeals/{id}/mediatable-fields` 只对 `status='completed'` 的申诉回合返回其中 `decision='rejected'` 的字段（含其申诉意见与已授权证据）；对进行中/取消/过期回合生成返回 `409 MEDIATION_SOURCE_NOT_FROZEN`，选入申诉未驳回字段返回 `MEDIATION_FIELD_NOT_REJECTED`，证据白名单引用不存在/不属于该字段的证据得 `400 INVALID_MEDIATION_EVIDENCE`。同一申诉回合至多一个未终结调解包，两个办理页面并发只成功一个，另一个得 `409 MEDIATION_ALREADY_OPEN`（部分唯一索引 + `BEGIN IMMEDIATE` 双保险）。
- **两层配置（启动即冻结）**：`POST /api/mediation-packages { roundId, note, fields:[{key, evidenceOpinionIds}], layer1, layer2 }`。
  - 第一层 `layer1`：2-5 名**新调解人**一次性邀请、逐邀请字段授权（第一层字段的子集，每字段至少一个邀请）、字段级接受/驳回阈值（1..邀请数）、独立限时与超时策略（`escalate` 超时自动升级/`revoke_unused` 撤销未使用邀请/`fail` 超时终结）、以及**升级条件** `escalateRejectedCount`（1..第一层字段数）；
  - 第二层 `layer2`：3-5 名**仲裁人**一次性邀请、独立阈值/限时/超时策略（`complete`/`revoke_unused`/`fail`），**字段必须是第一层字段子集**。第一层创建即激活、冻结策略并起算倒计时；第二层保持 `pending`，邀请使用远期占位有效期。
- **严格的层级门控**：第一层未达到升级条件前，仲裁链接**不能校验、不能查看、不能提交**（`409 ARBITRATION_NOT_OPEN`）。第一层每出现一个终局字段即检查“驳回字段数 ≥ 升级条件”：达到则第一层立即冻结完成（其余未决字段按策略自动驳回、留档为 `decided_by_policy='timeout_mediation'`），并**按第一层结束时的冻结快照**为每个第二层字段生成“允许向仲裁人披露的第一层结论摘要”（只有聚合结论/阈值结果/选中证据，**不含第一层调解人身份与逐字意见**），同时冻结第二层策略、起算倒计时、重定仲裁邀请有效期；未达到条件且第一层全部手工终局，则调解包按第一层终局完成，第二层标记 `skipped` 永不开放。第一层冻结后其结果不可修改（重复决议返回同一结果，`MEDIATION_FIELD_ALREADY_DECIDED`），第一层邀请链接也不再可校验。
- **两层各自的一次性邀请与脱敏视图**：第一层链接 `/mediation-review?t=…`（Cookie `mid/mcsrf`），第二层链接 `/arbitration-review?t=…`（Cookie `arb/accsrf2`）；令牌 256 位随机、库存哈希，重复使用/过期/撤销分别返回对应 `*_ALREADY_USED/_EXPIRED/_REVOKED`，校验接口按 IP 限流。调解人只能看到本邀请授权的脱敏字段、原批次与申诉的驳回结论、调解包选中的冻结证据（原复核人匿名）；仲裁人只能看到仲裁授权字段、第一层结论摘要与透传的选中证据。越权字段读取/提交得 `403 *_FIELD_NOT_AUTHORIZED`，无会话/CSRF 缺失分别 `401/403`，携带他份回执得 `403 *_RECEIPT_MISMATCH`。
- **意见幂等**：同一处理人对同一字段的意见支持幂等重试（同键同指纹返回同一条，换指纹 `OBJECTION_DUPLICATE_KEY`），每邀请每字段至多一份（`*_FIELD_DUPLICATE_OPINION`，UNIQUE 兜底并发）。
- **逐字段终局决议**：接受需本层提出意见的不同处理人数 ≥ 该层冻结接受阈值（不足 `ACCEPT_THRESHOLD_NOT_MET`）；驳回需本层已校验未提意见人数 ≥ 驳回阈值（不足 `REJECT_THRESHOLD_NOT_MET`），理由 2-200 字持久化；并发决议以 `WHERE decision IS NULL` 判定，只有一个成功。
- **仲裁接受必须三源关联**：仲裁接受在新的更正办理中同时写入**调解包、上一层结论（`mediation_disclosures`）与原批次/申诉回合来源**（`correction_objections.mediation_opinion_id/source_package_id/source_batch_id/source_round_id/source_tier=2` 与 `mediation_corrections.disclosure_id`）。**同一调解包只能产生一份进行中的更正**：部分唯一索引 `idx_mediation_corrections_one_open` 保证两个办理页面并发接受只成功一个，另一个得 `409 MEDIATION_CORRECTION_IN_PROGRESS`；存在进行中的其他办理时 `409 OPEN_WORKFLOW_EXISTS`。更正完成后新回执回填字段/意见/来源关系并关闭调解包；放弃更正只清理进行中关系（终局历史保留）。
- **取消与超时**：任何一层尚无字段终局决议时可取消（未使用邀请立即失效、写操作全部 `410`）；已有终局决议后只能保留历史（`409 MEDIATION_HAS_DECISIONS`）。层级超时由后台 5 秒扫描、启动恢复与接口惰性检查三路触发，以 `timeout_fired_at IS NULL` 条件更新为唯一判定，**重复触发不产生第二次结果**；`revoke_unused` 只撤销未使用邀请（办理人仍须用已收集意见决议），`fail` 终结调解包，第一层 `escalate` 与第二层 `complete` 会自动驳回未决字段（留档）后升级/完成。
- **审计与持久化**：办理人页面展示调解包↔申诉回合↔原批次↔更正办理关系、两层状态/邀请状态/倒计时/证据摘要/阈值进度/处理人；时间线在申诉回合条目之后插入 `kind: 'mediationPackage'` 条目，事件类型为 `review.mediation.created/tier.completed/tier.timeout/escalated/field.* /arbitration.invitation.consumed/arbitration.opinion.submitted/arbitration.field.*/correction.completed/cancelled`。刷新、重新登录、服务重启后冻结版本、两层状态、意见、决议、来源关系、超时结果和完整时间线保持一致（两层免登录会话均持久化）。

## 案件组（case group，跨包冲突协调与按冻结顺序处理）

办理人可把**同一原批次**下、由多个**已完成申诉回合**生成的调解包加入同一个案件组，按冻结顺序协调处理；加入时做跨包冲突检查并生成**只读组级冻结快照**，组开始处理后配置冻结、成员包的来源/字段授权/两层配置/历史不能被改写，成员包也不能重复加入其他未终结案件组。

- **加入冲突检查（不通过即拒绝并留档）**：`POST /api/case-groups { anchorPackageId }` 以第一个包为锚点建组；`POST /api/case-groups/{id}/members { packageId }` 继续加入。加入时按四个维度检查：① **原批次字段**必须相同（否则 `409 CASE_PACKAGE_BATCH_MISMATCH`）；② **调解包状态**必须第一层处理中、第二层未开放、无字段终局决议（`CASE_PACKAGE_STATUS_CONFLICT`/`CASE_PACKAGE_TIER2_OPEN`）；③ **申诉来源**同一申诉回合只能有一个成员包（`CASE_PACKAGE_SOURCE_CONFLICT`）；④ **字段授权**按原批次字段（`source_field_id`）判重，与既有成员重叠即 `CASE_PACKAGE_FIELD_CONFLICT`；另有⑤ **当前更正**冲突（已存在进行中更正 → `CASE_PACKAGE_CORRECTION_CONFLICT`）。每个被拒包写入 `case_group_rejections`（原因/时间留档）。两个办理页面同时加入同一成员包只成功一个（部分唯一索引 `idx_case_group_members_one_open` + `BEGIN IMMEDIATE`，负者 `CASE_PACKAGE_ALREADY_IN_GROUP`）；`GET /api/case-groups/{id}/candidates` 列出同批次可加入的候选包及其不合格原因。
- **组级配置（开始处理前可改，开始即冻结）**：`POST /api/case-groups/{id}/config { minCompletions, memberOrder, timeoutPolicy, ttlMinutes, disclosedPackageIds }`。最少完成数（1..成员数）、成员处理顺序（必须是全部成员的一个排列）、组级超时策略（`block_remaining` 到点阻断未开放成员 / `fail` 强制终结未开放成员）、组级限时与允许披露的跨包摘要白名单（只能引用本组成员）。`POST /api/case-groups/{id}/start` 以 `status='collecting'` 条件更新为唯一判定，**同一案件组不能启动两次处理**（`CASE_GROUP_ALREADY_STARTED`），开始后不能再加入成员或改配置；收集阶段可 `POST /api/case-groups/{id}/cancel`（成员释放，可加入其他组）。
- **按冻结顺序的组级开放条件**：成员包第一层达到其自身升级条件时还要过组门控——只有在冻结顺序中的位置达到组级最少完成数、且所有前置成员第一层已终局时才开放第二层仲裁（级联放行后续成员）；前置未终局则第一层终局**挂起等待**（成员 `parked`，包保持 `mediating`，仲裁邀请继续被拒 `409 CASE_GROUP_ARBITRATION_NOT_OPEN`）；超出最少完成数或组级超时落定则第二层永不开放（成员 `arbitration_blocked`，包按第一层终局完成）。其他成员包的仲裁邀请在未达组级开放条件前一律继续拒绝。
- **跨包摘要最小披露**：成员开放第二层瞬间按白名单生成 `case_group_disclosures`，仲裁人上下文 `context.group.crossPackageSummary` 只含其他成员包的**聚合结论**（顺序、成员/包状态、第一层驳回计数与自动驳回计数）并显式 `containsOtherPackageFields:false`，**不含任何其他包的字段 key、字段原文、证据逐字内容或处理人身份**；每个成员包仍只按自己的字段权限向其调解人/仲裁人展示内容。
- **并发与原子更新**：成员包产生进行中更正、被取消或过期/失败时，组状态与剩余成员在同一事务内按冻结规则原子更新（成员置 `cancelled`/`failed` 并固化结果，其余成员按顺序重新门控）；组级超时由后台 5 秒扫描、启动恢复与接口惰性检查触发，以 `timeout_fired_at IS NULL` 条件更新为唯一判定，**重复扫描不产生第二份结果**。
- **结果与审计持久化**：组完成或失败后保存每个成员的结果、冲突原因、处理顺序、邀请状态、倒计时（`result_json`）；时间线在锚点调解包条目之后插入 `kind: 'caseGroup'` 条目，事件类型为 `review.caseGroup.created/member.joined/member.rejected/configured/started/member.parked/member.arbitration.opened/member.arbitration.blocked/member.failed/timeout/completed/failed/cancelled`。刷新、重新登录、服务重启后组快照、成员关系、权限摘要、门控状态、超时结果与时间线保持一致。

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
| GET | `/api/review-batches/{id}/appealable-fields` | 是 | 原批次中可申诉的驳回字段、原证据意见与申诉理由选项 |
| POST | `/api/review-appeals` | 是 | 创建复核申诉回合（2-5 个新邀请、字段授权、独立阈值与限时、证据白名单，返回一次性链接） |
| GET | `/api/review-appeals?batchId=` | 是 | 申诉回合清单（可按批次/回执过滤） |
| GET | `/api/review-appeals/{id}` | 是 | 申诉回合详情（邀请、证据授权、合并意见、决议、倒计时） |
| POST | `/api/review-appeals/{id}/cancel` | 是 | 取消申诉回合（已有字段决议则失败，历史不删除） |
| POST | `/api/review-appeals/{id}/fields/{fieldId}/accept` | 是 | 接受申诉（达到接受阈值，进入同一份更正并关联原批次来源） |
| POST | `/api/review-appeals/{id}/fields/{fieldId}/reject` | 是 | 驳回申诉（满足驳回阈值，理由必填） |
| POST | `/api/appeal-review/validate` | 否 | 申诉邀请一次性校验，成功后建立免登录申诉会话 |
| GET | `/api/appeal-review/context` | 否 | 仅本回合本邀请授权字段的脱敏视图、原驳回决议、证据摘要与合并意见 |
| POST | `/api/appeal-review/opinions` | 否 | 新复核人提交申诉意见（需申诉会话 + CSRF，幂等） |
| POST | `/api/appeal-review/logout` | 否 | 退出并清除本机申诉会话 |
| GET | `/api/review-appeals/{id}/mediatable-fields` | 是 | 已完成申诉回合中可生成调解包的驳回字段、申诉意见与授权证据 |
| POST | `/api/mediation-packages` | 是 | 生成只读争议调解包（两层配置：第一层 2-5 调解人、第二层 3-5 仲裁人、字段范围/阈值/限时/超时策略/升级条件，返回两层一次性链接） |
| GET | `/api/mediation-packages` | 是 | 调解包清单（可按 `roundId`/`receiptNo` 过滤） |
| GET | `/api/mediation-packages/{id}` | 是 | 调解包详情（冻结快照、两层状态、邀请、字段意见与决议、倒计时、更正来源） |
| POST | `/api/mediation-packages/{id}/cancel` | 是 | 取消调解包（任何一层已有字段终局决议则失败，历史保留） |
| POST | `/api/mediation-packages/{id}/fields/{fieldId}/accept` | 是 | 接受本层字段意见（达到冻结接受阈值；仲裁接受关联调解包+第一层结论+原批次来源进入新更正） |
| POST | `/api/mediation-packages/{id}/fields/{fieldId}/reject` | 是 | 驳回本层字段（满足冻结驳回阈值，理由必填；第一层驳回字段达到升级条件即开放第二层） |
| POST | `/api/mediation-review/validate` | 否 | 第一层调解邀请一次性校验（第二层未升级时调解链接之外的入口不可用） |
| GET | `/api/mediation-review/context` | 否 | 仅本层本邀请授权字段的脱敏视图、原批次/申诉驳回结论、选中证据与本层合并意见 |
| POST | `/api/mediation-review/opinions` | 否 | 调解人提交第一层意见（需调解会话 `mid/mcsrf` + CSRF，幂等） |
| POST | `/api/mediation-review/logout` | 否 | 退出并清除本机调解会话 |
| POST | `/api/arbitration-review/validate` | 否 | 第二层仲裁邀请一次性校验（第一层未达升级条件返回 `ARBITRATION_NOT_OPEN`） |
| GET | `/api/arbitration-review/context` | 否 | 仅仲裁授权字段的脱敏视图、第一层结论摘要（无第一层调解人身份/逐字意见）与选中证据 |
| POST | `/api/arbitration-review/opinions` | 否 | 仲裁人提交第二层意见（需仲裁会话 `arb/accsrf2` + CSRF，幂等） |
| POST | `/api/arbitration-review/logout` | 否 | 退出并清除本机仲裁会话 |
| POST | `/api/case-groups` | 是 | 创建案件组（以锚点调解包为第一个成员，做加入冲突检查并冻结组快照） |
| GET | `/api/case-groups` | 是 | 案件组清单（可按 `batchId`/`receiptNo` 过滤） |
| GET | `/api/case-groups/{id}` | 是 | 案件组详情（冻结快照、配置、成员状态/结果、冲突拒绝留档、审计事件、倒计时） |
| GET | `/api/case-groups/{id}/candidates` | 是 | 同原批次可加入的调解包候选及不合格原因 |
| POST | `/api/case-groups/{id}/members` | 是 | 加入成员包（原批次/申诉来源/字段授权/当前更正/状态冲突检查，不通过拒绝并留档） |
| POST | `/api/case-groups/{id}/config` | 是 | 保存组级配置（最少完成数、成员顺序、超时策略、限时、披露白名单；开始处理后冻结） |
| POST | `/api/case-groups/{id}/start` | 是 | 启动按冻结顺序处理（条件更新保证不能启动两次；可在请求中一并提交最终配置） |
| POST | `/api/case-groups/{id}/cancel` | 是 | 收集阶段取消案件组（成员释放，可加入其他组） |
| POST | `/api/verify` | 否 | 编号+核验码核验，仅返回脱敏结果，按 IP 限流 |
| GET | `/api/public/receipts/{no}/print?code=` | 否 | 脱敏可打印回执文档 |
| GET | `/verify` | 否 | 免登录核验页面 |
| GET | `/review` | 否 | 免登录复核页面（先完成邀请校验） |
| GET | `/batch-review` | 否 | 免登录多方批次复核页面（先完成批次邀请校验） |
| GET | `/appeal-review` | 否 | 免登录复核申诉评议页面（先完成申诉邀请校验，只展示本回合授权内容） |
| GET | `/mediation-review` | 否 | 免登录第一层调解评议页面（先完成调解邀请校验，只展示本层授权内容） |
| GET | `/arbitration-review` | 否 | 免登录第二层仲裁评议页面（第一层升级后才开放） |

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
- `review_appeal_rounds`：复核申诉回合（状态 `in_review/completed/cancelled/expired`、独立限时 `expires_at`、申诉理由摘要、取消/过期时间，部分唯一索引保证同一批次至多一个未终结回合）
- `review_appeal_fields`：申诉逐字段配置（引用原批次字段 `source_field_id`、独立接受/驳回阈值、申诉理由、逐字段决议/理由/处理人、关联更正办理与新回执）；部分唯一索引保证每个驳回字段在未终结回合中至多被申诉一次
- `review_appeal_invitations` / `review_appeal_invitation_fields` / `review_appeal_sessions`：申诉回合 2-5 个限时一次性邀请（令牌只存哈希）、逐邀请字段授权、独立 Cookie（aid/accsrf）的免登录会话
- `review_appeal_opinions`：申诉意见（每邀请每申诉字段唯一、幂等键、脱敏值快照）；查询时按字段合并展示
- `review_appeal_evidence`：办理人显式授权向新复核人披露的原批次证据摘要（原意见引用 + 匿名别名“原复核人N” + 脱敏值快照与逐字说明）；未授权的原意见不出现
- `mediation_packages`：争议调解包（状态 `mediating/arbitrating/completed/cancelled/expired/failed`、生成瞬间的冻结快照 `frozen_snapshot_json`（原批次决议/申诉决议/证据选择/更正来源/两层配置），部分唯一索引保证同一申诉回合至多一个未终结调解包）
- `mediation_tiers`：两个顺序处理层级（`tier=1` 调解 / `tier=2` 仲裁；状态 `pending/active/completed/skipped/cancelled/timed_out/failed`、邀请数、限时、开始时冻结的策略、开始/截止/完成时间、升级条件 `escalate_rejected_count`、超时落定时间与结果）；第二层创建时为 `pending`，升级时才激活
- `mediation_fields`：两层逐字段配置（`tier`、引用申诉字段与原批次字段、l1/l2 两套接受/驳回阈值）与逐字段终局决议（含系统按冻结策略自动驳回标记 `decided_by_policy='timeout_mediation'`、理由、处理人、关联更正办理与新回执）；`UNIQUE(package_id, tier, step, field)`
- `mediation_frozen_opinions` / `mediation_frozen_evidence`：调解包生成瞬间冻结复制的申诉意见与选中的授权证据摘要（匿名别名、脱敏值快照）；未选中字段/证据不写入
- `mediation_invitations` / `mediation_invitation_fields` / `mediation_sessions`：两层各自的限时一次性邀请（令牌只存哈希；第二层邀请升级前为远期占位有效期，升级时重定截止）、逐邀请字段授权，以及独立 Cookie（第一层 `mid/mcsrf`、第二层 `arb/accsrf2`）的免登录会话
- `mediation_opinions`：第一层调解意见与第二层仲裁意见（每邀请每字段唯一、幂等键、脱敏值快照）
- `mediation_disclosures`：第一层升级到第二层时按冻结快照生成的“允许向仲裁人披露的第一层结论摘要”（聚合结论与选中证据，不含第一层调解人身份/逐字意见），每个第二层字段唯一
- `mediation_corrections`：调解包接受与更正办理的来源关系（原批次/申诉回合/层级/第一层结论引用）；部分唯一索引保证同一调解包至多一份进行中的更正
- `case_groups`：案件组（状态 `collecting/processing/completed/failed/cancelled`、组级冻结快照 `frozen_snapshot_json`、最少完成数、冻结成员顺序、组级超时策略与截止时间、跨包披露白名单、超时落定时间与结果）
- `case_group_members`：组成员（加入瞬间冻结的来源/字段授权/两层配置/邀请状态 `member_snapshot_json`、门控状态 `joined/layer1_open/parked/arbitrating/arbitration_blocked/completed/failed/cancelled/released` 与原因、每成员结果/顺序/邀请状态/倒计时 `result_json`、`open_group_id`）；部分唯一索引 `idx_case_group_members_one_open` 保证成员包不能同时处于两个未终结案件组
- `case_group_rejections`：加入时未通过冲突检查的调解包留档（原批次/申诉来源/字段授权/当前更正/状态五类原因码与明细）
- `case_group_disclosures`：成员开放第二层时生成的跨包摘要（只含其他成员包的聚合结论，不含字段 key/原文/处理人身份），每个查看包唯一
- `correction_objections`：批次字段意见/普通异议/申诉意见/调解意见与更正办理的统一来源关联（新增 `mediation_opinion_id`、`source_package_id`、`source_tier`；完成更正时据此回填新回执编号；放弃更正时调解包终局保留、仅清理进行中关系）
- `tokens`：令牌哈希、绑定维度、过期、使用、撤销状态
- `submissions`：幂等键、请求指纹、提交和确认结果
- `events`：创建、草稿、确认、退回、签发回执、撤销、更正创建、复核邀请/异议/处理、多方批次阶段/决议、复核申诉回合、争议调解包两层处理等审计事件

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
