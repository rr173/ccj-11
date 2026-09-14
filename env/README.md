# 服务端权威的多步骤网页办理流程（含可核验电子回执）

一个可 Docker 部署的参考实现：每一步都必须由服务端确认；浏览器地址、后退、直接调接口、令牌重放、跨页面使用、网络重试或并发提交都不能跳过步骤或重复生成确认。四步全部确认成功后，系统生成唯一回执编号与核验码的**电子回执**，内容固定、可下载打印、可免登录核验，且不能被退回修改或覆盖；任何更正都会产生一条全新的办理记录与新回执。

## 演示账号

- `alice` / `password123`
- `bob` / `password123`
- `carol` / `password123`
- `dave` / `erin`（回执功能测试账号，密码相同）
- `processor1` / `processor2`（异议处理人角色账号，密码相同；处理撤销异议，只能看到分配给自己的异议与脱敏回执）
- `supervisor1`（异议主管角色账号，密码相同；查看逾期升级通知留痕、审批一次延期申请、维护线下领取网点与时间段容量）
- `pickup1`（领取人员角色账号，密码相同；仅能在预约时间窗口含宽限内凭预约编号+一次性领取码确认线下交付）
- `auditor1` / `auditor2`（审计员角色账号，密码相同；`auditor2` 为未授权对照账号，只能看到显式授权的归档脱敏视图；审计员均可只读查看全部撤销异议、通知留痕与延期记录的完整审计记录）

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
- **回执撤销异议：异议编号/状态/处理期限、提交时独立冻结的回执快照、文本说明与逐份补充材料、只追加的完整处理历史（操作人/时间/原因/前后状态）、处理人分配与确认撤销后的回执状态全部持久化；刷新、重登、服务重启后异议状态、处理意见与时间线保持一致（`receipt_objections` / `receipt_objection_events` / `receipt_objection_materials`）**
- **回执核验码密钥 `receipt-secret.key`（核验能力依赖它，务必随数据卷备份）**
- **线下领取预约：领取网点与时间段/容量/容量版本、预约冻结快照（网点名/地址/时间范围/容量版本）、占用名额账、预约版本、领取码 HMAC 摘要（只存摘要、轮换/消费留痕）、成功与拒绝的只追加审计全部持久化；刷新、重登、重启后一致（`pickup_locations` / `pickup_slots` / `pickup_appointments` / `pickup_codes` / `pickup_audit`）**

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


## 回执撤销与异议处理

办理人可以针对**自己持有的有效回执**发起一次“撤销异议”：填写异议原因（5-500 字）并上传**一份 `.txt` 纯文本说明**（≤64KB）。系统在提交瞬间**冻结回执快照**（独立复制一份，原回执之后如何变化都不影响它），生成异议编号（`YY-YYYYMMDD-XXXXXXXX`，Crockford Base32）、当前状态（`submitted`）与处理期限（默认 7 个自然日，`RECEIPT_OBJECTION_TTL_MS`，逾期仅标记不改状态）。异议自动分配给当前在办量最少的处理人账号（`processor` 角色）。

### 1. 发起限制（明确拒绝）

| 情况 | HTTP | 错误码 |
| --- | --- | --- |
| 未登录 | 401 | `UNAUTHENTICATED` |
| 回执不存在 / 不属于当前账号 | 404 | `RECEIPT_NOT_FOUND` |
| 回执已撤销 | 409 | `RECEIPT_REVOKED` |
| 该回执已有进行中异议 | 409 | `OBJECTION_IN_PROGRESS` |
| 原因长度不合法 / 缺少文本附件 / 附件非 `.txt` 或超过 64KB | 400 | `INVALID_REASON` / `ATTACHMENT_*` |
| 当前没有处理人账号 | 503 | `NO_PROCESSOR_AVAILABLE` |

同一回执的**进行中异议至多一条**（`submitted/accepted/supplementing`，部分唯一索引兜底并发）；异议进入终态（`rejected/revoked`）后可再次发起。

### 2. 处理人与状态机

异议处理人在 `/processor` 工作台（演示账号 `processor1` / `processor2`）只能看到**分配给自己**的异议（未分配的访问返回 404），且看到的是**脱敏回执内容**（复用复核脱敏规则：姓名/手机号/证件号/详细地址全部遮罩），可读取文本说明原文。处理动作：

```
submitted ──受理(accept)──▶ accepted
accepted  ──要求补充材料(request-supplements，必须填写说明)──▶ supplementing
supplementing ──办理人补充(supplement，必须再上传一份 .txt 与说明)──▶ accepted
accepted  ──确认撤销(confirm-revocation)──▶ revoked（终态，原回执同事务置为 revoked）
accepted / supplementing ──驳回(reject，理由 5-300 字)──▶ rejected（终态）
```

任何非法跳转（如未受理先驳回、`supplementing` 直接确认撤销、已终态重复操作）都返回 `409 OBJECTION_INVALID_TRANSITION` 或 `409 OBJECTION_ALREADY_HANDLED`，历史不被覆盖。所有状态变化在 `BEGIN IMMEDIATE` 事务中以“当前状态 + 行级条件更新”为唯一判定，并发处理只有一个成功。

**确认撤销后**：原回执状态置为 `revoked`（记录撤销时间与“经异议确认撤销”原因），免登录核验接口 `POST /api/verify` 返回 `410 RECEIPT_REVOKED`；但原始快照永久留档，办理人仍可查本人回执，授权审计员可查看完整记录。

### 3. 处理意见与历史只追加、不可覆盖

- `receipt_objection_events` 为只追加表：每次状态变化记录操作人、操作角色、时间、原因/备注与前后状态（`from_status → to_status`），没有任何 UPDATE/DELETE 路径；重复处理返回同一历史。
- 文本说明（初始 1 份 + 每次补充 1 份）逐字冻结在 `receipt_objection_materials`，列表只回传摘要（文件名/字节数/行数/上传时间），正文仅在详情接口返回。
- 办理人刷新、重新登录或**服务重启**后仍能看到异议状态、处理意见（驳回理由、补充要求、确认撤销意见）、文本材料与完整时间线。

### 4. 权限分级

- **办理人**（handler）：只能发起/查看/补充自己的异议；回执申请人信息同样只返回脱敏结果。
- **处理人**（processor）：只能访问 `/api/processor/*`，看到被分配异议的脱敏回执；不能访问办理、审计等任何其他接口。
- **审计员**（auditor）：`/api/auditor/receipt-objections` 只读，可按权限查看**全部**异议的完整审计记录——未脱敏冻结快照、文本原文、逐次状态变化、快照 SHA-256 摘要与原回执当前状态；没有任何写操作。

### 5. 接口与时间线

- 办理人：`POST/GET /api/receipt-objections`、`GET /api/receipt-objections/{YY编号}`、`POST /api/receipt-objections/{YY编号}/supplement`。
- 处理人：`GET /api/processor/objections[?status=]`、`GET /api/processor/objections/{YY编号}`、`POST /api/processor/objections/{YY编号}/{accept|request-supplements|reject|confirm-revocation}`。
- 审计员：`GET /api/auditor/receipt-objections[?receiptNo=&status=]`、`GET /api/auditor/receipt-objections/{YY编号}`。
- `/api/state` 的回执版本时间线在对应回执之后插入 `kind: 'receiptObjection'` 条目，携带异议编号、来源回执、状态、处理期限与完整处理历史（`receipt.objection.*` 事件同时写入回执所属办理记录的审计时间线）。


## 异议超期升级与通知留痕（objection escalation & notifications）

在撤销异议模块之上新增的**到期提醒 → 逾期升级 → 一次延期审批**闭环。所有提醒、升级、已读与延期动作均持久化且只追加；后台调度（默认每 1 秒扫描，`OBJECTION_SWEEP_MS`，`NO_OBJECTION_SWEEP=1` 关闭定时器）、服务启动恢复扫描与各列表接口惰性触发，全部幂等。

### 1. 提醒与升级规则

- **到期前提醒**：按配置的提前提醒时间点（`OBJECTION_REMINDER_LEAD_MS`，默认 `24h,2h`，逗号分隔多个）生成**待发送**（`pending`）通知，同次扫描立即推进为已发送（`sent`）。每个提醒点向**处理人**（定向）与**办理人**（定向）各生成一条。
- **逾期升级**：异议超过处理期限（且仍处于 `submitted/accepted/supplementing`）时，首个扫描事务条件更新 `overdue_at`（`WHERE overdue_at IS NULL`，只成功一次），并按权限分流升级记录：**处理人**定向一条、**主管**（supervisor 角色）按角色广播一条；审计员不持有个人通知行，由审计接口查看全部。
- **停机恢复**：服务停机期间错过的提醒点在启动恢复扫描时**补生成留痕**（负载含 `backfilled: true`）；终态异议不再产生任何通知。
- 通知负载在**生成瞬间定型**，只含异议编号、当前状态、截止时间、来源回执与升级层级，**从数据源上**不含证件号、完整地址、完整手机号——任何角色视角都不可能因漏脱敏而泄露。

### 2. 一次延期（处理人申请 / 主管审批）

- 被分配处理人可对进行中的异议填写延期原因（5-300 字）申请**唯一一次**延期（`receipt_objection_extensions`，`UNIQUE(objection_id, ordinal)` 兜底并发申请，两个页面同时提交只有一个成功）。
- 主管在 `/supervisor` 工作台（演示账号 `supervisor1`）看到待审批申请（不含敏感快照字段），可**批准**（截止时间顺延 `OBJECTION_EXTENSION_MS`，默认 3 天；清除逾期标记）或**拒绝**（拒绝必须填写 ≥2 字说明；截止时间不变）。每个 pending 申请只能决议一次（条件更新兜底双击/并发批准+拒绝只落一个）。
- 批准后若再次逾期，按第 2 层升级（`overdue-l2`），第 1 层升级记录永久保留；延期通知（申请/批准/拒绝）同样留痕。

### 3. 只追加与幂等

- 通知唯一索引 `(objection_id, kind, dedupe_key, audience, target_user_id)`：重复调度、定时器重入、多实例同时扫描、服务重启补扫都不会产生重复通知；`pending→sent→read` 是仅有的状态推进，负载永不更新。
- 每次提醒生成、逾期标记、升级、确认已读、延期申请/批准/拒绝都向 `receipt_objection_events` **追加**事件（`receipt.objection.reminder.scheduled / overdue / notification.read / extension.requested|approved|rejected`），历史没有 UPDATE/DELETE 路径。
- 处理人确认已读（`POST .../notifications/{id}/read`）带接收人校验，重复确认幂等且只在首次追加事件；他人通知一律返回 404（不暴露存在性）。

### 4. 权限分流

- **办理人**（handler）：`GET /api/receipt-objection-notifications`（仅本人定向：提醒、延期结果）、`POST /api/receipt-objection-notifications/{id}/read`；`/api/state` 带回 `objectionNotifications` 与未读数——刷新、重新登录、服务重启后提醒状态一致。
- **处理人**（processor）：`GET /api/processor/notifications[?status=&kind=]`、`POST /api/processor/notifications/{id}/read`、`POST /api/processor/objections/{YY编号}/extension`；异议详情附 `escalation`（本人可见接收方的通知与延期记录）。
- **主管**（supervisor）：只能访问 `/api/supervisor/*`——通知留痕（逾期升级广播、延期申请通知）、确认已读、延期审批；不能办理、不能访问业务或审计接口。
- **审计员**（auditor）：`GET /api/auditor/receipt-objection-notifications[?kind=&audience=&status=&objectionNo=]` 查看**全部通知**完整留痕（含接收人、发送/已读时刻、去重键、定型负载），`GET /api/auditor/receipt-objection-extensions[?status=]` 查看全部延期申请与决议；只读，无任何写接口。完整证件号/地址/手机号仍只在异议冻结快照审计视图中按需返回。

## 可版本化工作日历（versionable working calendar）

异议处理期限不再按自然时间硬算，而是按**版本化工作日历**以工作分钟计算。管理员（supervisor）维护每天的工作时段、节假日与临时停办日；已发布日历只追加、永不修改，进行中的异议固定使用创建时的版本，换版必须经主管“预览 → 确认迁移”。

### 1. 日历版本与计时模型

- `working_calendars` 为只追加版本表：`v0` 是全天 24 小时**兼容日历**（旧异议/测试沿用自然日 TTL），`v1` 为默认工作日历（周一至周五 09:00-12:00、13:30-17:30，时区 `Asia/Shanghai`）；`working_calendar_pointer` 单行指向当前生效版本。
- 新异议创建时固定（pin）当前版本（`calendar_version_id/version`），办理时长为 `RECEIPT_OBJECTION_SLA_MINUTES`（默认 7 个工作日 × 8 小时 = 3360 分钟）。截止时间由纯函数 `advanceWorkingMinutes(calendar, createdAt, slaMinutes)` 计算：遇到工作时段外、周末、节假日、临时停办日自动顺延，返回值带**逐段顺延说明**（类型/起讫/原因），写入 `receipt_objection_timing`（只追加台账）并在异议详情中展示。
- 时钟模型：`anchor_at`（本轮计时起点）+ `remaining_minutes`（剩余工作分钟）→ `deadline_at`。纯算术 `workingMinutesBetween` 只统计工作时间，天然跳过非工作时段。

### 2. 补充材料暂停 / 恢复

- 处理人“要求补充材料”（accepted → supplementing）即**暂停**：按固定日历计算 anchor→now 已消耗工作分钟，扣减后冻结 `remaining_minutes`，写入 `receipt_objection_pauses`（部分唯一索引保证同一异议至多一条打开暂停段）。暂停期间既不提醒也不标记逾期。
- 办理人“补交材料”（supplementing → accepted）即**恢复**：以恢复时刻为新 anchor，从冻结的剩余工作分钟继续推进，非工作时段自动顺延；恢复台账带逐段顺延原因。
- 重复暂停、重复恢复均以状态条件更新 + 暂停行唯一索引拒绝；**并发补交**（两个请求同时恢复）只有一个事务成功（测试覆盖，返回 `[200,409]`），不会多扣或多加时间。暂停中被驳回会关闭打开的暂停段。

### 3. 日历更新与受控迁移（不悄悄改变在办异议）

- 发布新版本（`POST /api/supervisor/working-calendars`）立即成为当前生效版本，但**不影响任何在办异议**——它们仍按固定版本计时。
- 主管先 `POST /api/supervisor/calendar-migrations/preview` 生成**受影响清单**：逐条给出当前截止时间、换版后的预计截止时间（运行中按当前时刻重算；暂停中只换版本、恢复时才重算），并明确列出**排除项**（已逾期、已终结）。预览冻结为一份带 `digest` 的快照。
- 确认迁移 `POST /api/supervisor/calendar-migrations/{id}/apply` 必须回传同一 `digest`：预览后任一候选终结/逾期/已换版，整体 `MIGRATION_CONFLICT` 中止、不落任何变更，要求重新预览；已经逾期或终结的异议**绝不迁移**。成功迁移逐条写 `objection_calendar_migrations`、追加迁移事件与计时台账（前后截止/剩余分钟、目标版本）。已应用预览不可重复确认。

### 4. 调度跟随当前截止时间；审计可见

- 提醒/逾期调度始终以异议**当前有效截止时间**为准；提醒去重键含截止时间（`reminder-{ordinal}@{deadlineAt}`），恢复或迁移产生新截止后可按新时间点再次提醒，旧提醒永久留档。
- 服务重启后：版本指针、固定版本、暂停状态、剩余分钟、截止时间、计时台账与迁移记录全部从持久层恢复，启动补扫不产生重复。
- 审计员可 `GET /api/auditor/working-calendars`（全部版本）、`GET /api/auditor/calendar-migrations[?objectionNo=]`（迁移留痕），并在异议详情查看使用过的版本与每段计时/暂停/迁移记录。
- 兼容开关 `CALENDAR_LEGACY_DEFAULT=1` 时新异议固定 v0 全天日历（自然日 TTL），供只验证旧语义的环境使用。

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

## 可验证审计归档（只读冻结 + 摘要链 + 分级查阅 + 后台导出）

办理人可对**已经发生**的一段审计事件创建只读归档，来源可选：**原批次 / 申诉回合 / 调解包 / 案件组**（`POST /api/archives`，体：`sourceType/sourceId/note/auditorGrants`）。

- **创建瞬间冻结**：单个 `BEGIN IMMEDIATE` 事务内完成“收集来源范围内已发生事件（`created_at <= freezeAt`）→ 一致性校验 → 复制冻结 → 计算摘要链”。冻结内容包括**事件顺序**（`ordinal`、原始 `events.id`、时间戳）、**来源关系**（批次→申诉→调解包→案件组→更正回执的链）、**状态摘要**（来源当前状态/配置/成员）、**脱敏规则**与**权限快照**。归档事件存独立副本（`audit_archive_events`），**创建后没有任何 UPDATE/DELETE 路径**，业务记录后续变化（新增事件、再次决议等）**不会改变已生成归档**；对同一来源重复归档产生 `version+1` 的新归档，旧版本原样保留。
- **创建拒绝与留档**：以下三类问题在生成前校验，失败时不产生归档行而在 `audit_archive_rejections` 留档原因（`409`）：
  - `ARCHIVE_EVENT_GAP` 事件缺口：根来源缺少起始事件（如无 `review.batch.created`）或所选范围没有任何已发生事件；
  - `ARCHIVE_EVENT_ORDER_CONFLICT` 顺序冲突：事件自增序号不单调、事件时间倒退、同一具体来源出现两条创建事件、来源进入终态后又出现状态事件；
  - `ARCHIVE_SOURCE_INCONSISTENT` 来源不一致：事件 detail 中的 `batchId/roundId/packageId/groupId` 在库中不存在或归属链对不上（如调解包不属于事件声称的回合）。
- **可连续校验的摘要链**：`genesis = sha256("ARCHIVE-GENESIS-v1"|归档号|来源|版本)`，`hash_i = sha256(prev_hash | 规范化事件负载)`，最终摘要 `final_hash` 冻结在归档主行；每次查阅都重算，任何一处冻结副本被篡改都会使 `chain.continuous=false` 并给出断点（ordinal 与原因）。被篡改的归档**不能导出**（后台任务终检失败 `ARCHIVE_CHAIN_INVALID`），且没有任何“修复归档”接口——只能重新归档出新版本。

### 三种分级视图（按归档创建时的权限快照，权限后变不扩大已生成归档）

- **办理人视图** `GET /api/archives/{id}`：获准范围内的完整字段与操作人（actor 角色+标识）、状态摘要、来源关系、脱敏规则、逐事件负载与摘要。
- **审计员视图**（`auditor` 角色，页面 `/auditor`，接口 `GET /api/auditor/archives[/{id}]`）：只有在该归档**创建时**被 `auditorGrants` 按用户名显式授权的审计员可见；只返回按冻结脱敏规则处理后的事件（剥离逐字意见/驳回理由/取消理由/IP/备注，遮罩邀请标签）、**来源关系**与**摘要链校验结果**；操作人统一只显示角色（`handler/reviewer/system`），不含身份。未授权审计员列表中看不到该归档，直接访问得 `403 ARCHIVE_VIEW_FORBIDDEN`；审计员不能访问办理人接口。演示账号 `auditor1`（授权对照）、`auditor2`（未授权对照）。
- **外部核验视图**（免登录页面 `/archive-verify`，接口 `POST /api/archives/external-verify`）：办理人先 `POST /api/archives/{id}/external-code` 取得**一次性核验码**（只返回一次，默认 24 小时有效；同一归档新码作废旧码）；核验**只能看到 9 个字段**：归档号、来源类型、冻结时间、事件数量、时间范围、摘要链是否连续、最终状态。看不到任何事件原文、操作人、来源关系，也得不到证件号码/地址。核验码**只能使用一次**（重复 `410 EXTERNAL_CODE_USED`），作废/过期分别返回 `EXTERNAL_CODE_REVOKED/EXPIRED`。

### 后台导出任务（幂等、断点续传、一次性凭证、过期清理）

`POST /api/archives/{id}/exports { idempotencyKey }` 启动后台导出：

- **幂等键**：办理人同键重放返回同一任务（`replay:true`）；同键用于其他归档得 `409 EXPORT_IDEMPOTENCY_CONFLICT`。
- **同一归档同一版本至多一份进行中任务**：部分唯一索引 + `BEGIN IMMEDIATE` 保证两个页面并发启动只有一个成功，另一个得 `409 EXPORT_ALREADY_RUNNING` 并返回已存在任务。
- **分块 + 断点续传**：按事件数分块（默认每块 50 条，`ARCHIVE_EXPORT_CHUNK_SIZE` 可调小），每完成一块写入 `audit_export_chunks` 并更新 `completed_chunks/progress`；后台扫描（默认 1s，`ARCHIVE_SWEEP_MS`）认领 queued 任务、从已完成分块之后继续。任务锁含 30s TTL，持锁进程崩溃后可被接管；**服务重启时无条件释放旧进程的 running 锁并从持久化分块进度续跑**（`recoverArchiveExportsOnStartup`）。
- **完成与版本摘要**：完成时由冻结事件重算组装 JSON 文件（含归档号、来源、冻结时间、事件数、时间范围、状态摘要、来源关系、权限快照、脱敏规则、逐事件负载、分块摘要），写回 `file_version/file_digest(file SHA-256)/file_size` 与保留期（默认 24 小时）；**下载动作只读，不修改任何归档或业务数据**。
- **查询/取消/重新下载**：`GET /api/archives/exports/{id}` 查状态（含进度、失败原因、文件摘要、保留期）；`POST …/exports/{id}?action=cancel` 取消 queued/running 任务（已完成/失败不可取消，其活动凭证一并作废）；已完成任务可多次“重新下载”，每次签发新凭证。
- **一次性下载凭证**：`POST …/exports/{id}?action=credential` 对已完成任务签发一次性凭证（默认 15 分钟）；免登录兑换 `GET /api/archives/exports/{id}/download?credential=…`（凭证本身即授权），响应带 `X-File-Version` 与 `X-Content-Digest: sha-256=…`。重复使用 `410 EXPORT_CREDENTIAL_USED`；越权归档 `EXPORT_CREDENTIAL_ARCHIVE_MISMATCH`；任务取消 `EXPORT_TASK_CANCELLED`；任务/文件过期被清理 `EXPORT_TASK_EXPIRED`；凭证过期 `EXPORT_CREDENTIAL_EXPIRED`；未完成 `EXPORT_NOT_COMPLETED`。
- **过期清理**：后台扫描把超过保留期的已完成任务文件内容清空并置 `expired`（任务行与审计事件留档），其活动凭证一并过期；过期凭证与外部核验码同样被置过期。办理页展示归档来源、冻结时间、事件数量、摘要链校验、三种视图权限、导出进度、凭证状态与失败原因。

## 回执线下领取预约与一次性交付

已签发且未撤销回执的办理人可预约到领取网点线下领取，领取人员只能在预约时间窗口（含可配置宽限）内凭“预约编号 + 一次性领取码”确认交付。

### 网点与时间段容量（主管维护）

- 网点有名称/地址/状态（可用/停用）与版本；停用后不能再新建时间段或预约，已有预约的冻结信息不变。
- 时间段归属于网点，记录开始/结束时间、容量、`capacity_version`、占用名额与开放/关闭状态；同一网点时间段重叠拒绝；关闭后不再接受预约。
- 容量可随时上调/下调（不得低于当前占用，调整使 `capacity_version` +1）；**已有人预约的时间段时间范围锁定**（返回 `SLOT_TIME_LOCKED`），需要改时间应新建时间段。
- 主管调整网点名称/地址或容量，**不会改写任何已有预约冻结的信息**；主管页面同时展示每个时间段的占用与最近的预约/交付失败原因。

### 预约、冻结信息与一次性领取码

- 预约在单个 `BEGIN IMMEDIATE` 事务内以条件更新 `UPDATE … SET occupied=occupied+1 WHERE occupied < capacity` 原子扣减名额；两个页面同时抢最后一个名额恰好一个成功，另一个得到明确的 `SLOT_CAPACITY_FULL`（名额已满）。
- 创建瞬间冻结预约编号 `YY-YYYYMMDD-XXXXXXXX`、网点名称/地址、时间范围、容量版本与宽限；之后主管的任何调整都不影响这些字段。
- 同一回执至多一条进行中预约（部分唯一索引兜底并发）。
- 领取码为 10 位（`XXXXX-XXXXX`）随机码，**明文只在预约/改约成功的当次响应出现一次**；服务端只保存按 `(预约编号, 码版本)` 计算的 HMAC 摘要（`pickup_codes`，状态 current/rotated/consumed），任何列表或详情接口都不再返回明文，数据库也不含明文。
- 改约与取消都必须携带当前预约版本号（乐观锁，旧版本返回 `APPOINTMENT_VERSION_CONFLICT`）。改约在同一事务内先原子占用新名额、再释放旧名额，并轮换领取码（旧码状态 `rotated`，立即失效）；取消成功即释放名额。**同一预约上并发的取消/改约/确认交付在同一版本号上互斥：恰好一个动作成功，其余明确返回冲突（版本冲突 / 状态不允许 / 已交付只读），名额账、版本号与最终状态保持一致。**
- 预约状态：`booked`（已预约）/ `rescheduled`（已改约）/ `cancelled`（已取消）/ `delivered`（已交付，只读终态）/ `revoked`（回执撤销失效）/ `expired`（超过结束+宽限未领取）。

### 一次性交付与明确拒绝

- 可领取区间为 `[startAt, endAt + graceMs]`，两端点都包含；交付先判窗口再判码：
  - 早于开始 → `PICKUP_TOO_EARLY`；晚于结束+宽限 → `PICKUP_TOO_LATE`（即使已被后台扫描落定为 expired 也给同一结果）。
  - 码不匹配（错码）→ `PICKUP_CODE_INVALID`；**该码属于其他预约（跨预约使用）→ `PICKUP_MISMATCH`，且不改变任何预约或领取码状态**；命中已轮换的旧码 → `PICKUP_CODE_OLD`；命中已消费码或预约已交付 → `PICKUP_ALREADY_DELIVERED`。
- 成功交付把当前码标记为 `consumed`、预约置为 `delivered`，任何重放（同人/他人/跨会话）都无法再通过；交付后取消、改约、重复交付一律只读拒绝。
- 领取人员页面只显示履约所需最小信息（预约编号、冻结的网点/地址/时间窗口、状态、交付时间），不含办理人身份、备注等。

### 撤销联动、过期落定与只追加审计

- 办理人自行撤销回执、或处理人经撤销异议确认撤销时，在**同一事务**内把该回执所有未交付预约置为 `revoked`、释放名额并轮换领取码；已交付预约保持只读，不受影响。
- 后台每 `PICKUP_SWEEP_MS`（默认 1s，启动时先扫一次）把超过结束+宽限仍未交付的预约落定为 `expired`（过期不退还名额，名额在该时间段已被消耗）；读取路径对尚未落定的到期预约也呈现“已过期”，且不开写事务，避免与并发取消/改约/交付争锁。
- 所有成功动作与每次明确拒绝都写入只追加表 `pickup_audit`（数据库触发器禁止 UPDATE/DELETE）；办理人可查看本人预约的完整操作历史，主管可查看全局成功/失败留痕。预约、容量占用、码摘要与审计在刷新、重新登录、服务重启后保持一致。

## 归档版本对比与受控重放审阅（只读报告 + 冻结副本重放）

办理人可为**同一来源**的两个**已冻结归档版本**生成只读比较报告，并从报告获准的事件子集创建**受控重放审阅会话**。两者都严格只读：比较不触碰任一归档，重放不触碰归档、业务记录或导出文件。

### 只读比较报告

`POST /api/archive-comparisons { baseArchiveId, targetArchiveId, note }`：

- **前置校验**：两个归档都属于当前办理人（否则 `404 COMPARE_ARCHIVE_NOT_FOUND`，不区分“不存在/他人所有”）；不能是同一归档（`400 COMPARE_SAME_ARCHIVE`）；必须 `source_type + source_id` 完全相同（`409 COMPARE_NOT_SAME_SOURCE`）；版本低者自动作为基准（base）、高者作为目标（target）。
- **摘要链失效拒绝比较**：生成前实时重算两个归档的摘要链，任一失效即 `409 ARCHIVE_CHAIN_INVALID`，响应 `detail.side` 指明是基准还是目标版本及其断点；失效归档之间不产生任何报告行。
- **事件对齐（按事件顺序）**：以原始事件 id 为键、基准序列中的目标下标求最长递增子序列（LCS）对齐，条目按合并后的事件顺序编号，逐事件分类：
  - `added` 新增：只存在于目标（较新）版本；
  - `deleted` 删除：只存在于基准（较旧）版本；
  - `modified` 修改：两版共有但**冻结内容**不同（比较用不含链信息的事件内容摘要，因此后继事件新增不会把前面的事件误判为修改）；
  - `unchanged` 未变化：两版共有且内容一致；
  - `unaligned` 无法对齐：同一事件在两个版本中的相对顺序不一致（落在 LCS 之外），条目给出明确原因，**永远不能加入重放**。
- **四类汇总比较**：摘要链连续性（两版最终摘要、跨版本顺序是否可对齐）、**来源关系差异**（新增/移除的来源链）、**状态摘要差异**（逐字段 from/to）、**权限快照差异**（新增/移除的授权审计员、外部视图字段）。
- **冻结与校验**：规范化报告体计算 SHA-256 `digest` 存 `audit_comparisons.body_json/digest`，条目另存 `audit_comparison_entries`；报告与条目创建后**没有任何改写路径**。每次读取都重算 digest 并实时重算两份归档摘要链（`verification.reportOk / digestMatches / archiveChainsOk / reasons[]`）；报告生成后归档再新增业务事件、再归档新版本，**报告内容与 digest 均不变**。
- 办理人查询 `GET /api/archive-comparisons[/{id}]`；审计员查询 `GET /api/auditor/comparisons[/{id}]`：**只有同时被两个版本创建时的权限快照授权**才可见（否则列表不可见、直接访问 `403 COMPARE_VIEW_FORBIDDEN`），审计员视图不含任何重放会话或意见信息。

### 受控重放审阅会话

`POST /api/archive-comparisons/{id}/replays { entryKeys[], ttlMinutes }` 从报告中获准的**已对齐事件**创建：

- **事件子集受控**：空子集 `400 REPLAY_SUBSET_EMPTY`；任何不在报告中的键、或 `unaligned` 条目一律 `403 REPLAY_EVENT_OUT_OF_SCOPE`；他人报告 `404 COMPARE_NOT_FOUND`。创建时报告 digest 与双归档摘要链必须全部有效，否则 `409 REPLAY_REPORT_INVALID`。
- **冻结副本**：所选事件在单事务内复制到 `audit_replay_events`（新增/修改/未变化取目标版本，删除取基准版本）；重放期间只读这份副本，敏感字段继续按归档视图在服务端脱敏。
- **版本号、过期时间与一次性提交令牌**：会话有单调递增 `version`（每次写入 +1）、`expiresAt`（默认 5 分钟～7 天，`REPLAY_MIN_TTL_MS/REPLAY_MAX_TTL_MS` 可配）。写操作必须先 `POST /api/replay-sessions/{id}/submit-token` 取一枚**一次性提交令牌**（默认 10 分钟，`REPLAY_SUBMIT_TOKEN_TTL_MS`），每次意见/暂停/恢复/取消消费一枚；新令牌作废旧令牌，使用已用/作废/过期令牌分别返回 `REPLAY_TOKEN_INVALID/REPLAY_TOKEN_EXPIRED`。
- **三类写入**：`POST /api/replay-sessions/{id}/opinions { entryKey, kind, comment/reason, idempotencyKey, submitToken, expectedVersion }`：
  - `comment` 添加意见（可多次追加，1-1000 字）；`confirm` 标记已确认；`object` 提出异议（需 2-500 字理由）。
  - **幂等重试**：同一事件的意见按 `idempotencyKey` 幂等，同键同指纹的网络重试（即使发生在暂停/取消/过期之后、令牌已用尽时）返回**同一条意见**（`replay:true`）；同键换内容 `409 REPLAY_IDEMPOTENCY_CONFLICT`。
  - **并发确认唯一**：每个事件至多一条 confirm/object 结论，部分唯一索引兜底，两个页面并发确认**只有一个成功**，负者得 `409 REPLAY_ALREADY_DECIDED`，重复确认同样明确拒绝。
  - 旧版本提交 `409 REPLAY_VERSION_CONFLICT`（先于令牌校验，不让有效令牌因版本过期而作废）；事件不在本会话 `403 REPLAY_EVENT_OUT_OF_SCOPE`。
- **暂停 / 恢复 / 取消**：`POST /api/replay-sessions/{id}/pause|resume|cancel`（带令牌与 `expectedVersion`）。
  - 暂停后**不能写入意见**（`409 REPLAY_PAUSED`），但仍可获取控制令牌；
  - 恢复必须重新校验**比较报告 digest 与两份归档摘要链仍然有效、会话版本未变化**，否则 `409 REPLAY_REPORT_INVALID`，校验通过版本 +1 并补发写令牌；
  - 取消后会话**只读**：写操作 `409 REPLAY_CANCELLED_READONLY`，历史意见与审计时间线全部保留；重复取消 `REPLAY_ALREADY_CANCELLED`；
  - 过期后所有写操作 `410 REPLAY_EXPIRED`（后台 sweep 落定状态），GET 仍返回只读视图。
- **重启/刷新一致性**：会话状态、版本、过期时间、冻结事件、意见、审计时间线全部持久化；服务重启、重新登录、页面刷新后从服务端恢复一致视图与倒计时，提交令牌重新获取即可。办理页展示版本差异、报告校验状态、重放进度（已选/已确认/异议/意见/剩余）、倒计时与审计时间线。
- **隔离边界**：重放意见只存 `audit_replay_opinions`，审计员比较视图与免登录外部核验都**看不到任何重放意见原文**；比较、重放、下载全过程不修改 `audit_archives/audit_archive_events` 与任何业务表（只有 INSERT 到比较/重放自有表，且归档审计时间线追加 `audit.comparison.created/audit.replay.created` 事件）。

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
| GET | `/api/archives/auditors` | 是（办理人） | 可授权的 auditor 角色账号列表 |
| POST | `/api/archives` | 是（办理人） | 创建只读归档（`sourceType/sourceId/note/auditorGrants`）；缺口/顺序冲突/来源不一致时拒绝并留档 |
| GET | `/api/archives` | 是（办理人） | 归档列表、拒绝留档与导出任务列表 |
| GET | `/api/archives/{id}` | 是（办理人） | 办理人完整视图（冻结事件、操作人、来源关系、摘要链校验、导出任务） |
| POST | `/api/archives/{id}/external-code` | 是（办理人） | 签发外部一次性核验码（只返回一次） |
| POST | `/api/archives/{id}/exports` | 是（办理人） | 启动后台导出（必带 `idempotencyKey`；并发只放行一个） |
| GET | `/api/archives/exports/{id}` | 是（办理人） | 查询导出任务进度/失败原因/文件摘要/凭证状态 |
| POST | `/api/archives/exports/{id}?action=cancel` | 是（办理人） | 取消排队中/进行中的导出（活动凭证一并作废） |
| POST | `/api/archives/exports/{id}?action=credential` | 是（办理人） | 对已完成导出生成一次性下载凭证 |
| POST | `/api/archives/exports/{id}?action=redownload` | 是（办理人） | 对已完成导出重新生成下载凭证 |
| GET | `/api/archives/exports/{id}/download?credential=` | 否 | 一次性凭证兑换导出文件（重复使用/越权/取消/过期均拒绝；下载不改业务数据） |
| GET | `/api/auditor/archives[/{id}]` | 是（审计员） | 仅授权归档的脱敏视图、来源关系与摘要链校验结果 |
| POST | `/api/archive-comparisons` | 是（办理人） | 为同一来源的两个已冻结归档版本生成只读比较报告（任一摘要链失效即拒绝） |
| GET | `/api/archive-comparisons[/{id}]` | 是（办理人） | 比较报告列表/详情（事件对齐、四类差异、digest 与双摘要链实时校验） |
| POST | `/api/archive-comparisons/{id}/replays` | 是（办理人） | 从报告获准的已对齐事件子集创建受控重放会话（越权/未对齐事件拒绝） |
| GET | `/api/archive-comparisons/{id}/replays` | 是（办理人） | 报告下的重放会话列表 |
| GET | `/api/replay-sessions[/{id}]` | 是（办理人） | 重放会话列表/详情（冻结副本、意见、进度、版本、倒计时、审计时间线） |
| POST | `/api/replay-sessions/{id}/submit-token` | 是（办理人） | 签发一次性提交令牌（新令牌作废旧令牌；取消/过期时拒绝） |
| POST | `/api/replay-sessions/{id}/opinions` | 是（办理人） | 提交意见/确认/异议（幂等键、期望版本、一次性令牌；并发确认只成功一个） |
| POST | `/api/replay-sessions/{id}/pause` | 是（办理人） | 暂停重放（暂停期间禁止写入意见） |
| POST | `/api/replay-sessions/{id}/resume` | 是（办理人） | 恢复重放（重新校验报告 digest 与双归档摘要链、版本未变化） |
| POST | `/api/replay-sessions/{id}/cancel` | 是（办理人） | 取消重放（会话只读，历史意见与审计事件保留） |
| GET | `/api/auditor/comparisons[/{id}]` | 是（审计员） | 仅当同时被两个版本授权时可见的脱敏比较内容（不含任何重放意见） |
| POST | `/api/receipt-objections` | 是（办理人） | 对本人有效回执发起撤销异议（原因 + 一份 .txt 文本说明；冻结快照/编号/处理期限） |
| GET | `/api/receipt-objections[?receiptNo=]` | 是（办理人） | 本人撤销异议列表（脱敏申请人、材料摘要） |
| GET | `/api/receipt-objections/{YY编号}` | 是（办理人） | 本人异议详情（完整处理历史、材料摘要、处理意见） |
| POST | `/api/receipt-objections/{YY编号}/supplement` | 是（办理人） | 在“待补充材料”状态追加一份 .txt 与说明，异议回到已受理 |
| GET | `/api/processor/objections[?status=]` | 是（处理人） | 分配给当前处理人的异议列表 |
| GET | `/api/processor/objections/{YY编号}` | 是（处理人） | 被分配异议详情（脱敏回执、材料原文、完整历史） |
| POST | `/api/processor/objections/{YY编号}/accept` | 是（处理人） | 受理（submitted → accepted） |
| POST | `/api/processor/objections/{YY编号}/request-supplements` | 是（处理人） | 要求补充材料（accepted → supplementing，必带说明） |
| POST | `/api/processor/objections/{YY编号}/reject` | 是（处理人） | 驳回（accepted/supplementing → rejected，理由 5-300 字） |
| POST | `/api/processor/objections/{YY编号}/confirm-revocation` | 是（处理人） | 确认撤销（accepted → revoked，同事务撤销原回执） |
| POST | `/api/processor/objections/{YY编号}/extension` | 是（处理人） | 对被分配的进行中异议申请唯一一次延期（原因 5-300 字） |
| GET | `/api/processor/notifications[?status=&kind=]` | 是（处理人） | 本人定向通知（提醒/逾期升级/延期结果）与未读数 |
| POST | `/api/processor/notifications/{id}/read` | 是（处理人） | 确认已读（重复确认幂等；他人通知 404） |
| GET | `/api/receipt-objection-notifications[?status=&kind=]` | 是（办理人） | 本人定向的提醒/延期结果通知与未读数 |
| POST | `/api/receipt-objection-notifications/{id}/read` | 是（办理人） | 确认已读本人通知（重复确认幂等） |
| GET | `/api/supervisor/notifications[?status=&kind=]` | 是（主管） | 逾期升级广播与延期申请通知（可确认已读） |
| POST | `/api/supervisor/notifications/{id}/read` | 是（主管） | 确认已读主管通知（幂等） |
| GET | `/api/supervisor/extensions[?status=]` | 是（主管） | 全部延期申请与决议（默认列待审批） |
| POST | `/api/supervisor/extensions/{id}/approve` | 是（主管） | 批准延期（顺延截止、清除逾期标记；决议仅一次） |
| POST | `/api/supervisor/extensions/{id}/reject` | 是（主管） | 拒绝延期（必须 ≥2 字说明；截止时间不变） |
| GET | `/api/auditor/receipt-objection-notifications[?kind=&audience=&status=&objectionNo=]` | 是（审计员） | 全部通知完整留痕（接收人/发送/已读/去重键/定型负载，只读） |
| GET | `/api/auditor/receipt-objection-extensions[?status=]` | 是（审计员） | 全部延期申请与主管决议（只读） |
| GET | `/api/auditor/receipt-objections[?receiptNo=&status=]` | 是（审计员） | 全部撤销异议列表（只读、脱敏摘要） |
| GET | `/api/auditor/receipt-objections/{YY编号}` | 是（审计员） | 完整审计记录（未脱敏冻结快照、文本原文、逐次状态变化） |
| GET | `/api/supervisor/working-calendars` | 是（主管） | 日历版本清单与当前生效版本（只读） |
| GET | `/api/supervisor/working-calendars/{id}` | 是（主管） | 单个日历版本详情（工作时段/节假日/停办日） |
| POST | `/api/supervisor/working-calendars` | 是（主管） | 发布新版本（只追加，立即生效，不影响在办异议） |
| POST | `/api/supervisor/calendar-migrations/preview` | 是（主管） | 生成受影响在办异议预览（含预计截止与逾期/终结排除项） |
| GET | `/api/supervisor/calendar-migrations` | 是（主管） | 迁移预览历史 |
| GET | `/api/supervisor/calendar-migrations/{id}` | 是（主管） | 单个迁移预览 |
| POST | `/api/supervisor/calendar-migrations/{id}/apply` | 是（主管） | 按预览版本（回传 digest）确认迁移；冲突整体中止 |
| GET | `/api/auditor/working-calendars` | 是（审计员） | 全部日历版本（只读） |
| GET | `/api/auditor/calendar-migrations[?objectionNo=]` | 是（审计员） | 日历迁移留痕（只读） |
| GET | `/api/pickup/bookable-slots` | 是（办理人） | 可预约的开放时间段与剩余名额（含网点） |
| GET | `/api/pickup/appointments` | 是（办理人） | 本人全部预约（状态/冻结领取信息）与可预约时间段 |
| POST | `/api/pickup/appointments` | 是（办理人） | 凭回执编号+时间段原子抢占名额并预约（响应一次性返回领取码明文） |
| GET | `/api/pickup/appointments/{id}` | 是（办理人） | 预约详情（冻结信息）+ 只追加操作历史 |
| GET | `/api/pickup/appointments/{id}/history` | 是（办理人） | 该预约的只追加审计事件（含成功与明确拒绝） |
| POST | `/api/pickup/appointments/{id}/reschedule` | 是（办理人） | 改约（必带 expectedVersion；原子释放旧名额/占用新名额；旧领取码立即失效，返回新领取码一次） |
| POST | `/api/pickup/appointments/{id}/cancel` | 是（办理人） | 交付前取消并释放名额（必带 expectedVersion；已交付只读拒绝，版本不符明确冲突） |
| GET | `/api/pickup-delivery/context?appointmentNo=` | 是（领取人员） | 仅履约所需最小信息（网点/地址/时间窗口/状态，不含办理人身份） |
| POST | `/api/pickup-delivery/confirm` | 是（领取人员） | 窗口（含宽限）内凭预约编号+一次性领取码确认交付；错码/旧码/跨预约/过早/过期/重复均明确拒绝 |
| GET | `/api/supervisor/pickup/locations` | 是（主管） | 网点、全部预约占用、最近失败原因 |
| POST | `/api/supervisor/pickup/locations` | 是（主管） | 新建领取网点 |
| POST | `/api/supervisor/pickup/locations/{id}` | 是（主管） | 更新网点名称/地址（只影响今后预约） |
| POST | `/api/supervisor/pickup/locations/{id}/disable` | 是（主管） | 停用网点（不再接受新时间段/预约，已有预约不变） |
| GET/POST | `/api/supervisor/pickup/locations/{id}/slots` | 是（主管） | 查询/新建时间段（重叠拒绝；容量 ≥1） |
| POST | `/api/supervisor/pickup/slots/{id}` | 是（主管） | 调整容量/时间（已占用时锁时间；容量不得低于占用；容量变更产生新版本） |
| POST | `/api/supervisor/pickup/slots/{id}/close` | 是（主管） | 关闭时间段（不再接受预约） |
| GET | `/api/supervisor/pickup/appointments` | 是（主管） | 全部预约占用与最近拒绝原因 |
| GET | `/api/supervisor/pickup/audit` | 是（主管） | 领取模块最近审计事件（成功+拒绝） |
| GET | `/pickups` | 否（办理人登录） | 线下领取预约页面 |
| GET | `/delivery` | 否（领取人员登录） | 线下交付确认页面 |
| GET | `/pickup-admin` | 否（主管登录） | 领取网点/时间段容量/预约占用管理页面 |
| POST | `/api/archives/external-verify` | 否 | 外部一次性核验码核验，仅返回事件数量/时间范围/摘要链连续性/最终状态 |
| POST | `/api/verify` | 否 | 编号+核验码核验，仅返回脱敏结果，按 IP 限流 |
| GET | `/api/public/receipts/{no}/print?code=` | 否 | 脱敏可打印回执文档 |
| GET | `/verify` | 否 | 免登录核验页面 |
| GET | `/review` | 否 | 免登录复核页面（先完成邀请校验） |
| GET | `/batch-review` | 否 | 免登录多方批次复核页面（先完成批次邀请校验） |
| GET | `/appeal-review` | 否 | 免登录复核申诉评议页面（先完成申诉邀请校验，只展示本回合授权内容） |
| GET | `/mediation-review` | 否 | 免登录第一层调解评议页面（先完成调解邀请校验，只展示本层授权内容） |
| GET | `/arbitration-review` | 否 | 免登录第二层仲裁评议页面（第一层升级后才开放） |
| GET | `/auditor` | 否（审计员登录） | 审计员归档查阅页面 |
| GET | `/processor` | 否（处理人登录） | 异议处理人工作台（受理/补充/驳回/确认撤销） |
| GET | `/supervisor` | 否（主管登录） | 异议主管工作台（逾期升级留痕/延期审批） |
| GET | `/archive-verify` | 否 | 免登录归档外部核验页面（一次性核验码） |

所有非 GET 的登录态接口要求 `X-CSRF-Token`。会话 Cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 环境可启用 `Secure`。

## 存储模型

- `workflows`：多条记录（`sequence`、`status`、`source_receipt_no`），部分唯一索引保证每人至多一条 `open`、同一回执至多一条进行中的更正
- `workflow_steps.draft_json / confirmed_json / confirmed_at`：草稿与服务端确认
- `receipts`：回执编号（唯一）、固定快照、状态（`issued`/`revoked`）、撤销时间与原因
- `pickup_locations` / `pickup_slots`：领取网点（名称/地址/版本/启停）与可预约时间段（时间范围、容量、`occupied` 占用账、`capacity_version`、开放/关闭、重叠由服务端拒绝）
- `pickup_appointments`：线下领取预约（编号 `YY-…`、归属回执/办理人、状态机 `booked/rescheduled/cancelled/delivered/revoked/expired`、乐观锁 `version`、领取码版本 `code_seq`、宽限 `grace_ms`、**创建/改约瞬间冻结的网点名/地址/时间范围/容量版本**）；部分唯一索引保证同一回执至多一条进行中预约
- `pickup_codes`：领取码版本表（复合主键 `(appointment_id, code_seq)`），**只存 HMAC 摘要不存明文**；`current` 当前生效 / `rotated` 改约取消失效的旧码（保留摘要仅为精确区分旧码与错码）/ `consumed` 交付一次性消费
- `pickup_audit`：领取模块只追加审计（成功与明确拒绝、预约编号/回执/时间段、操作角色、原因、时间）；SQLite 触发器禁止任何 UPDATE/DELETE
- `receipt_objections`：回执撤销异议（编号 `YY-…`、归属回执/办理/办理人、处理人分配、状态 `submitted/accepted/supplementing/rejected/revoked`、原因、**提交时独立复制的冻结快照**与 SHA-256 摘要、发起时间与处理期限、受理/补充/终局各列）；部分唯一索引保证同一回执至多一条进行中异议
- `receipt_objection_events`：异议状态变化的只追加历史（顺序号、动作类型、前后状态、操作人/角色、原因/备注、时间），无任何更新/删除路径
- `receipt_objection_materials`：文本说明与补充材料（每份异议顺序号、文件名、逐字正文、上传人/角色、备注、时间）；列表只下发摘要，正文仅详情接口返回
- `receipt_objection_notifications`：异议提醒/升级/延期通知留痕（类型、去重键、接收角色与接收人、升级层级、生成瞬间定型的脱敏负载 `payload_json`、`pending/sent/read` 状态与发送/已读时刻）；部分唯一索引 `(objection_id, kind, dedupe_key, audience, target_user_id)` 保证重复调度/重启补扫不产生重复通知，行内容无更新路径
- `receipt_objection_extensions`：每份异议至多一条延期申请（`UNIQUE(objection_id, ordinal)` 兜底并发），含延期原因、申请顺延时长、原截止时间与主管批准/拒绝决议（决议人/时间/说明）；批准时异议截止时间顺延并清除逾期标记
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
- `audit_archives`：只读审计归档（来源类型 `batch/appeal/mediation/caseGroup` 与来源 id、版本号 `UNIQUE(source_type,source_id,version)`、冻结范围/状态摘要/来源关系/脱敏规则/权限快照、事件数与时间范围、`genesis_hash/final_hash`、创建时间；**只有 INSERT，没有更新冻结内容的路径**）
- `audit_archive_events`：冻结事件副本（顺序 ordinal、原 `events.id`、类型/步骤/脱敏前 detail、操作人角色与标签、`prev_hash/event_hash` 摘要链）；`UNIQUE(archive_id, source_event_id)` 防同一事件重复入档
- `audit_archive_rejections`：归档创建被拒绝（缺口/顺序冲突/来源不一致）时的原因码与明细留档
- `audit_exports`：导出后台任务（幂等键、`queued/running/completed/failed/cancelled/expired` 状态、分块总数/已完成数/进度、文件版本/内容/`file_digest`/大小、worker 锁与锁 TTL、保留期；部分唯一索引 `idx_audit_exports_one_active` 保证同一归档同版本至多一份进行中）
- `audit_export_chunks`：导出分块内容与分块摘要（断点续传；重启后从已完成分块之后继续）
- `audit_export_credentials` / `audit_external_codes`：一次性下载凭证与外部核验码（只存哈希、`active/used/revoked/expired`、使用时间/IP、过期时间；重复使用/取消/过期均拒绝）
- `audit_comparisons` / `audit_comparison_entries`：只读归档版本比较报告（两版本引用、规范化报告体 `body_json` 与冻结 `digest`、新增/删除/修改/未变化/无法对齐计数、双摘要链状态；创建后无改写路径）与其按事件顺序排列的条目（`entry_key=e{source_event_id}`、两侧 ordinal/事件摘要/时间、无法对齐原因；`UNIQUE(comparison_id, entry_key)`）
- `audit_replay_sessions`：受控重放会话（`active/paused/completed/cancelled/expired` 状态机、单调 `version`、过期时间、暂停/恢复/取消时间与原因、已选/确认/异议/意见计数）
- `audit_replay_events`：会话创建时从比较报告引用的归档冻结事件复制的只读副本（来源侧 base/target、原始事件 id、类型/负载/操作人/时间/事件内容摘要）；`UNIQUE(replay_id, entry_key)`
- `audit_replay_opinions`：重放意见（`comment/confirm/object`、逐字内容或异议理由、幂等键与请求指纹、写入时版本）；幂等唯一索引支持网络重试，部分唯一索引保证每事件至多一条 confirm/object 结论（并发确认只成功一个）
- `audit_replay_submit_tokens`：重放一次性提交令牌（只存 SHA-256 哈希、`active/used/revoked/expired`、使用时间与关联意见/控制动作、过期时间；新签作废旧令牌）
- `audit_replay_audit`：重放审计时间线（只追加：created/paused/resumed/cancelled/expired/confirm/object/opinion），服务重启后从表恢复
- `users`：新增 `role`（`handler`/`auditor`；旧库自动补列），审计员只能访问 `/api/auditor/*` 脱敏视图
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
| `ARCHIVE_EXPORT_CHUNK_SIZE` | `50` | 归档导出每个后台分块包含的事件数（调小可观察断点续传） |
| `ARCHIVE_EXPORT_TTL_MS` | `86400000` | 已完成导出文件的保留期，到期后台清理文件内容（任务行留档为 expired） |
| `ARCHIVE_CREDENTIAL_TTL_MS` | `900000` | 一次性下载凭证有效期（15 分钟） |
| `ARCHIVE_EXTERNAL_CODE_TTL_MS` | `86400000` | 外部一次性核验码有效期（24 小时） |
| `ARCHIVE_SWEEP_MS` | `1000` | 归档导出后台扫描间隔（分块推进、崩溃接管、过期清理） |
| `REPLAY_MIN_TTL_MS` | `300000` | 受控重放会话最短有效期（5 分钟） |
| `REPLAY_MAX_TTL_MS` | `604800000` | 受控重放会话最长有效期（7 天） |
| `REPLAY_DEFAULT_TTL_MS` | `3600000` | 重放会话默认有效期（1 小时） |
| `REPLAY_SUBMIT_TOKEN_TTL_MS` | `600000` | 重放一次性提交令牌有效期（10 分钟） |
| `RECEIPT_OBJECTION_TTL_MS` | `604800000` | 撤销异议处理期限（默认 7 个自然日；仅决定截止时间与逾期标记，不自动流转） |
| `OBJECTION_REMINDER_LEAD_MS` | `86400000,7200000` | 到期前提醒时间点（毫秒，逗号分隔多个；提前量越大越早生成；停机错过会在恢复时补留痕） |
| `OBJECTION_EXTENSION_MS` | `259200000` | 主管批准一次延期后顺延的时长（默认 3 天；每份异议至多一次） |
| `OBJECTION_SWEEP_MS` | `1000` | 异议提醒/逾期升级/待发送通知后台扫描间隔；`NO_OBJECTION_SWEEP=1` 关闭定时器（启动恢复扫描仍执行） |
| `RECEIPT_OBJECTION_SLA_MINUTES` | `3360` | 新异议办理时长（工作分钟，按创建时固定的工作日历版本计算；默认 7 工作日 × 8 小时） |
| `OBJECTION_EXTENSION_MINUTES` | `1440` | 主管批准一次延期顺延的工作分钟（默认 3 工作日 × 8 小时；`OBJECTION_EXTENSION_MS` 仍用于 v0 全天兼容日历） |
| `CALENDAR_LEGACY_DEFAULT` | `0` | 置 `1` 时新异议固定全天 24 小时 v0 日历（自然日 TTL，旧语义/测试用） |
| `PICKUP_CODE_SECRET` | 空 | 线下领取码 HMAC 密钥；空则用数据目录下 0600 权限的 `pickup-code-secret.key`。密钥丢失后历史领取码无法再校验 |
| `PICKUP_GRACE_MS` | `900000` | 线下领取允许的宽限时间（结束后仍可交付的毫秒数，默认 15 分钟）；区间端点包含 |
| `PICKUP_SWEEP_MS` | `1000` | 超期未领取预约的后台落定扫描间隔；`NO_PICKUP_SWEEP=1` 只关周期定时器（启动恢复仍落定一次） |
| `DISPLAY_TIMEZONE` | `Asia/Shanghai` | 回执文档时间展示时区 |
