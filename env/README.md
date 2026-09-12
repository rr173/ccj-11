# 服务端权威的多步骤网页办理流程

一个可 Docker 部署的参考实现：每一步都必须由服务端确认；浏览器地址、后退、直接调接口、令牌重放、跨页面使用、网络重试或并发提交都不能跳过步骤或重复生成确认。

## 演示账号

- `alice` / `password123`
- `bob` / `password123`
- `carol` / `password123`

可通过环境变量 `DEMO_PASSWORD` 修改演示密码。生产环境应替换为正式的用户目录、密码轮换和 HTTPS。

## 本地运行

```bash
npm install
npm start
# http://localhost:3000
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

默认监听 3000。若由反向代理终止 HTTPS，请设置：

```yaml
COOKIE_SECURE: "1"
```

## 业务流程

1. 申请人信息
2. 联系地址
3. 办理事项
4. 确认声明

每个用户有一条持久化办理记录。`workflows.progress` 是唯一权威当前步骤，前端只能展示和提交该步骤；服务端不提供任何“跳到第 N 步”的推进接口。

## 关键安全语义

### 1. 服务端以当前进度为准

- `POST /api/tokens` 只为 `workflow.progress` 对应步骤发令牌。
- `POST /api/submissions` 在数据库事务中再次检查令牌步骤和当前步骤。
- 前端没有可影响服务端进度的 URL 参数；刷新、后退或手工调用后续接口都会得到 409，并返回服务端当前进度。
- 草稿也只能保存到服务端当前步骤。

### 2. 一次性、短期、强绑定令牌

领取：

```http
POST /api/tokens
{ "step": 0, "pageId": "..." }
```

提交：

```http
POST /api/submissions
{
  "step": 0,
  "pageId": "...",
  "token": "...",
  "idempotencyKey": "...",
  "payload": { ... }
}
```

令牌使用 256 位随机值，数据库只保存 SHA-256 哈希，并绑定：

- 当前用户
- 当前办理记录
- 登录会话
- 页面实例 ID（每次加载生成；两个标签页/窗口必不同，刷新后也会得到新页面 ID）
- 当前步骤
- 过期时间（默认 10 分钟，可由 `TOKEN_TTL_MS` 调整）

提交成功后令牌立即标记 `used_at`；其他页面的未使用令牌会在同一个数据库事务中撤销。以下情况均明确返回错误码，并返回最新进度：

- `TOKEN_USED`：重放已使用令牌
- `TOKEN_EXPIRED`：令牌过期
- `TOKEN_STEP_MISMATCH`：跨步骤使用
- `TOKEN_PAGE_MISMATCH`：换页面使用
- `TOKEN_SESSION_MISMATCH`：跨登录会话使用
- `STEP_NOT_CURRENT`：不是服务端当前步骤
- `CONCURRENT_PROGRESS_CHANGED` / `PROGRESS_MOVED`：并发冲突或进度已变化

### 3. 网络刷新/重试不重复推进

每次点击确认会生成一个 `idempotencyKey`，同一次网络重试复用该键。服务端对 `(workflow_id, idempotency_key)` 建唯一约束，并在事务内：

1. 锁定写事务；
2. 检查幂等键；
3. 校验并消费令牌；
4. 写入确认；
5. 推进进度。

同一幂等键、同一请求指纹的重试返回原提交 ID 和原确认号（`replay: true`），不会第二次推进，也不会生成第二份确认。更换幂等键重放旧令牌则返回 `TOKEN_USED`。

### 4. 两个页面并发提交

每个页面独立领取令牌。两个提交同时到达时，SQLite `BEGIN IMMEDIATE` 让事务串行化：一个成功，另一个看到进度已变化或自己的令牌已被撤销，返回 409、冲突原因和最新进度。失败页面不会本地覆盖状态，必须按返回的服务端状态重新读取。

### 5. 修改已确认内容会失效后续确认

已确认步骤可“退回修改”。服务端执行：

- 当前进度退回目标步骤；
- 目标步骤及之后所有 `confirmed_json/confirmed_at` 清空；
- 相关未使用令牌全部撤销；
- 原确认内容复制/保留为草稿，避免数据丢失；
- 受影响步骤不再显示为“已确认”，必须逐步重新确认。

### 6. 暂时离开后返回

进入应用先调用 `GET /api/state`。服务端从 SQLite 返回权威当前步骤、草稿、已确认内容和版本号。草稿由前端自动保存到服务端，因此关闭标签页、重启浏览器或重启服务后仍在。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 登录，创建 HttpOnly 会话和 CSRF Cookie |
| POST | `/api/logout` | 退出 |
| GET | `/api/state` | 获取当前用户、权威进度、草稿和确认 |
| POST | `/api/tokens` | 为当前步骤领取一次性下一步提交令牌 |
| POST | `/api/drafts` | 保存当前步骤草稿 |
| POST | `/api/submissions` | 校验令牌并原子确认当前步骤 |
| POST | `/api/rollback` | 退回已确认步骤并失效后续确认 |

所有非 GET 接口要求 `X-CSRF-Token`。会话 ID Cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 环境可启用 `Secure`。

## 存储模型

- `workflows.progress`：权威当前步骤
- `workflow_steps.draft_json`：未完成草稿
- `workflow_steps.confirmed_json`：服务端确认内容
- `tokens`：令牌哈希、绑定维度、过期、使用、撤销状态
- `submissions`：幂等键、请求指纹、提交和确认结果
- `events`：创建、保存草稿、确认、退回失效、完成等审计事件

SQLite 启用 WAL 和外键；所有推进操作都在同步的 `BEGIN IMMEDIATE` 事务中完成。
