# New API Auto Check-in

一个可部署在 Cloudflare Workers 或 Deno Deploy 上的 New API 自动签到管理台。Cloudflare 环境使用 `D1` 保存站点、日志和登录会话，Deno 环境可使用 `Deno KV` 或 `PostgreSQL` 保存同等数据；Web 管理页用于查看状态、导入站点、手动执行签到、批量签到和查看运行日志。

当前定时任务配置为每天北京时间 `08:00` 自动执行签到，签到日志默认保留最近 `7` 天。后台用户名通过 Cloudflare Secret `ADMIN_USERNAME` 配置，后台密码通过 `ADMIN_PASSWORD` 或 `ADMIN_PASSWORD_HASH` 配置。

## 功能特性

- Web 登录鉴权后台
- 使用 Cloudflare D1、Deno KV 或 PostgreSQL 持久化数据
- 新增、编辑、删除 New API 站点
- 保存站点 URL、系统访问令牌、用户 ID、启用状态和备注
- 查看站点总数、启用数量、24 小时执行次数和成功次数
- 手动执行单个站点签到
- 勾选多个站点后批量执行
- 一键执行全部启用站点
- 上传或粘贴 JSON 批量导入站点
- 查看最近运行日志、HTTP 状态、返回消息、额度结果和响应体
- 每天定时自动签到
- 自动清理过期日志，避免存储持续膨胀

## 签到认证要求

本项目按 New API 的 `UserAuth()` 签到机制实现，调用目标站点：

```http
POST /api/user/checkin
Authorization: Bearer {access_token}
New-Api-User: {user_id}
```

重要说明：

- `access_token` 必须是 New API 个人设置里生成的系统访问令牌。
- `access_token` 不是 `sk-` 开头的 AI 调用令牌。
- `New-Api-User` 必须填写与访问令牌匹配的数字用户 ID。
- 目标 New API 站点必须启用签到功能。
- 如果目标站点对签到接口强制启用了 Turnstile 校验，普通后端自动请求可能失败，需要目标站点提供机器签到接口或关闭该接口的 Turnstile 校验。

## 技术栈

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Cron Triggers
- Deno Deploy
- Deno KV
- Hono
- Zod
- TypeScript
- 原生 HTML/CSS/JavaScript WebUI

## 项目结构

```text
.
├── src/app.ts          # 共享 API、签到逻辑和 WebUI
├── src/index.ts        # Cloudflare Workers 入口
├── src/server.ts       # 服务器版入口，使用 SQLite 模拟 D1
├── src/deno.ts         # Deno Deploy 入口
├── src/deno-kv-d1.ts   # Deno KV 到 D1 查询接口的兼容层
├── src/postgres-d1.ts  # PostgreSQL 到 D1 查询接口的兼容层
├── deno.json           # Deno 本地开发和依赖映射
├── schema.sql          # D1 表结构
├── wrangler.toml       # Cloudflare Workers 配置
├── Dockerfile          # 服务器版 Docker 镜像
├── docker-compose.yml  # 服务器版 Compose 示例
├── package.json        # npm 脚本和依赖
├── .dev.vars.example   # 本地开发环境变量示例
└── README.md
```

## 本地开发

安装依赖：

```bash
npm install
```

复制本地环境变量示例：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-local-password
SESSION_TTL_SECONDS=604800
```

初始化本地 D1 表结构：

```bash
npm run db:migrate:local
```

启动本地开发服务：

```bash
npm run dev
```

### Deno 本地开发

本地需要先安装 Deno。复制 `.dev.vars.example` 后，可以把变量放到当前终端环境中，或直接用命令行临时设置：

```powershell
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD="your-local-password"
$env:CRON_SECRET="your-random-secret"
npm run deno:dev
```

Deno 入口默认使用本地 Deno KV，不需要执行 `schema.sql`。如果要用本地 PostgreSQL：

```powershell
$env:DATABASE_BACKEND="postgres"
$env:DATABASE_URL="postgresql://user:password@localhost:5432/newapi_checkin"
npm run deno:migrate:postgres
npm run deno:dev
```

## 从零部署

以下是 Cloudflare Workers 部署流程。如果部署到 Deno Deploy，请看后面的 “Deno Deploy 部署”。

### 1. 登录 Cloudflare

```bash
npx wrangler login
```

确认登录状态：

```bash
npx wrangler whoami
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create newapi-checkin-db
```

把输出里的 `database_id` 写入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "newapi-checkin-db"
database_id = "your-d1-database-id"
```

### 3. 初始化线上数据库

```bash
npm run db:migrate:remote
```

`schema.sql` 使用 `CREATE TABLE IF NOT EXISTS`，重复执行通常是安全的。

### 4. 设置后台登录 Secret

设置用户名：

```bash
npx wrangler secret put ADMIN_USERNAME
```

设置明文密码 Secret：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

也可以使用 SHA-256 哈希密码。程序会优先使用 `ADMIN_PASSWORD_HASH`：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('你的密码').digest('hex'))"
npx wrangler secret put ADMIN_PASSWORD_HASH
```

查看已设置的 Secret 名称：

```bash
npx wrangler secret list
```

### 5. 部署 Worker

```bash
npm run deploy
```

部署完成后，Wrangler 会输出 `workers.dev` 地址和 Cron 配置。

如果你准备公开仓库，请不要把自己的真实 Worker 地址、账号 ID、D1 `database_id` 或后台密码写入 README、`wrangler.toml` 或提交历史。

## 服务器部署

除了 Cloudflare Workers，本项目也提供服务器版。服务器版使用 Node.js 内置 SQLite 数据库，Web 管理页和 API 与 Workers 版本保持一致。

服务器版要求 Node.js `24+`。如果使用 Docker，镜像已经基于 `node:24-bookworm-slim`。

### Docker Compose

编辑 `docker-compose.yml`，至少修改后台密码：

```yaml
environment:
  ADMIN_USERNAME: "admin"
  ADMIN_PASSWORD: "change-this-password"
```

启动：

```bash
docker compose up -d --build
```

访问：

```text
http://localhost:3000
```

数据会持久化到本地 `./data/newapi-checkin.sqlite`。

### Node 直接运行

构建服务器版：

```bash
npm run build:server
```

启动：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=your-password npm run start:server
```

Windows PowerShell 示例：

```powershell
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD="your-password"
npm run start:server
```

服务器版常用环境变量：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `3000` | 监听端口 |
| `SQLITE_PATH` | `./data/newapi-checkin.sqlite` | SQLite 数据库路径 |
| `SCHEMA_PATH` | `./schema.sql` | 数据库初始化 SQL |
| `SCHEDULE_CRON` | `0 8 * * *` | 定时任务，使用 UTC 时间 |

## Deno Deploy 部署

### 1. 创建项目

在 Deno Deploy 新建项目，入口文件选择：

```text
src/deno.ts
```

项目会通过 `deno.json` 加载 `hono`、`zod`，PostgreSQL 模式会使用 Deno 文档示例里的 `npm:pg` 客户端。

### 2. 配置环境变量

在 Deno Deploy 项目设置里添加：

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 推荐 | 后台登录用户名，未设置时默认 `admin` |
| `ADMIN_PASSWORD` | 二选一 | 后台登录密码 |
| `ADMIN_PASSWORD_HASH` | 二选一 | 后台登录密码的 SHA-256 哈希，优先级高于 `ADMIN_PASSWORD` |
| `SESSION_TTL_SECONDS` | 否 | 登录会话有效期，默认 `604800` 秒 |
| `APP_NAME` | 否 | 页面标题，默认 `New API Auto Check-in` |
| `LOG_RETENTION_DAYS` | 否 | 日志保留天数，默认 `7` |
| `DATABASE_BACKEND` | 否 | `auto`、`kv` 或 `postgres`，默认 `auto` |
| `DATABASE_URL` / `PGHOST` 等 | PostgreSQL 时需要 | Deno Deploy 绑定 PostgreSQL 后会自动注入 |
| `CRON_SECRET` | 手动/外部触发时必填 | `/__cron/checkin` HTTP 触发接口的 Bearer Token |

Deno Deploy 官方数据库能力目前支持 `Deno KV` 和 `PostgreSQL`，且一个 App 目前只能绑定一种数据库实例。项目默认 `DATABASE_BACKEND=auto`：检测到 `DATABASE_URL`、`PGHOST`、`PGDATABASE` 或 `PGUSER` 时使用 PostgreSQL，否则使用 `Deno.openKv()`。

如果选择 PostgreSQL，项目启动时会执行 `CREATE TABLE IF NOT EXISTS` 初始化表结构。你也可以在 Deno Deploy 的 pre-deploy command 配置：

```bash
deno task migrate:postgres
```

### 3. 配置 Deno Cron

入口文件内置了 Deno Cron：

```ts
Deno.cron('daily new-api check-in', '0 0 * * *', ...)
```

如果你的 Deno Deploy 项目启用了 Cron，它会每天 UTC `00:00` 自动运行，对应北京时间 `08:00`。同时项目保留了一个受密钥保护的 HTTP 触发口，便于手动触发或接入外部 Cron：

```http
POST https://your-project.deno.dev/__cron/checkin
Authorization: Bearer {CRON_SECRET}
```

北京时间每天 `08:00` 对应 UTC `00:00`。

Deno 版本可使用 `Deno KV` 或 `PostgreSQL`，不需要创建 D1，也不需要执行 `schema.sql`。不同存储后端是独立数据，迁移平台时需要通过 WebUI 的 JSON 导入导出思路自行搬迁站点配置。

## 配置项

`wrangler.toml` 中的公开变量：

```toml
[vars]
APP_NAME = "New API Auto Check-in"
LOG_RETENTION_DAYS = "7"
```

Secret 变量：

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 推荐 | 后台登录用户名，未设置时默认 `admin` |
| `ADMIN_PASSWORD` | 二选一 | 后台登录密码 |
| `ADMIN_PASSWORD_HASH` | 二选一 | 后台登录密码的 SHA-256 哈希，优先级高于 `ADMIN_PASSWORD` |
| `SESSION_TTL_SECONDS` | 否 | 登录会话有效期，默认 `604800` 秒 |
| `DATABASE_BACKEND` | Deno 可选 | `auto`、`kv` 或 `postgres` |
| `DATABASE_URL` / `PGHOST` 等 | Deno PostgreSQL 时需要 | Deno Deploy 绑定 PostgreSQL 后自动注入 |
| `CRON_SECRET` | Deno 手动/外部触发时必填 | Deno HTTP 触发接口的 Bearer Token，Cloudflare 不需要 |

## 定时任务

当前配置：

```toml
[triggers]
crons = ["0 0 * * *"]
```

Cloudflare Cron 使用 UTC 时间，所以 `0 0 * * *` 表示每天 UTC `00:00`，对应北京时间 `08:00`。Deno Deploy 入口内置同样的 `Deno.cron` 计划，也可以用 `/__cron/checkin` 做手动或外部 Cron 触发。

定时任务会执行两件事：

- 删除超过 `LOG_RETENTION_DAYS` 天的签到日志。
- 对所有启用状态的站点执行签到。

## Web 管理台使用

### 站点管理

新增站点时需要填写：

| 字段 | 说明 |
| --- | --- |
| 站点名称 | 管理台显示名称，同名导入会覆盖 |
| 站点 URL | New API 站点地址，例如 `https://example.com` |
| 系统访问令牌 | New API 个人设置中生成的 Access Token |
| 用户 ID | 当前 New API 用户的数字 ID |
| 启用自动签到 | 关闭后不会参与定时和全部执行 |
| 备注 | 可选 |

### 手动签到

支持三种方式：

- 在站点行点击 `执行`，只执行单个站点。
- 勾选多个站点后点击 `执行选中`。
- 点击 `执行全部`，执行所有启用站点。

### 批量导入

WebUI 支持上传 `.json` 文件或直接粘贴 JSON 数组。

示例：

```json
[
  {
    "name": "主站",
    "baseUrl": "https://example.com",
    "accessToken": "your-access-token",
    "userId": 1,
    "enabled": true,
    "notes": "生产环境"
  },
  {
    "name": "备用站",
    "baseUrl": "https://demo.example.com",
    "accessToken": "your-access-token-2",
    "userId": 2,
    "enabled": true,
    "notes": "备用"
  }
]
```

导入规则：

- `name` 是唯一键。
- 同名站点会更新 URL、令牌、用户 ID、启用状态和备注。
- 不同名站点会新增。

## 数据表

`schema.sql` 中包含三张表：

| 表名 | 用途 |
| --- | --- |
| `sites` | 站点配置和最近签到状态 |
| `checkin_runs` | 签到执行日志 |
| `sessions` | Web 管理台登录会话 |

`sites` 主要字段：

| 字段 | 说明 |
| --- | --- |
| `base_url` | New API 站点根地址 |
| `access_token` | 系统访问令牌 |
| `user_id` | New API 用户 ID |
| `enabled` | 是否参与自动签到 |
| `last_status` | 最近一次执行状态 |
| `last_message` | 最近一次返回消息 |
| `last_checkin_at` | 最近一次执行时间 |
| `last_success_at` | 最近一次成功时间 |

`checkin_runs` 主要字段：

| 字段 | 说明 |
| --- | --- |
| `trigger_type` | 触发方式，例如 `manual`、`manual-all`、`cron` |
| `status` | 执行状态，例如 `success`、`failed`、`error` |
| `http_status` | 目标站点 HTTP 状态码 |
| `quota_awarded` | 签到获得额度 |
| `response_message` | 目标站点返回消息 |
| `response_body` | 目标站点原始响应体，最多保存前 4000 字符 |

## npm 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 本地启动 Wrangler 开发服务 |
| `npm run dev:server` | 本地启动服务器版开发服务 |
| `npm run build:server` | 构建服务器版到 `dist/` |
| `npm run start:server` | 运行已构建的服务器版 |
| `npm run deploy` | 部署到 Cloudflare Workers |
| `npm run deno:dev` | 本地启动 Deno 服务 |
| `npm run deno:check` | 使用 Deno 检查 Deno 入口 |
| `npm run deno:migrate:postgres` | 初始化 Deno PostgreSQL 表结构 |
| `npm run db:migrate:local` | 初始化本地 D1 表结构 |
| `npm run db:migrate:remote` | 初始化线上 D1 表结构 |
| `npm run cf-typegen` | 生成 Cloudflare 类型定义 |

## 常见问题

### 登录失败

检查 Secret 是否存在：

```bash
npx wrangler secret list
```

如果同时设置了 `ADMIN_PASSWORD_HASH` 和 `ADMIN_PASSWORD`，程序会优先校验 `ADMIN_PASSWORD_HASH`。

### 签到返回未登录

通常是以下原因：

- 使用了 `sk-` API Key，而不是系统访问令牌。
- `Authorization` 对应的用户和 `New-Api-User` 不一致。
- 用户 ID 填错。
- 目标站点令牌已失效。

### 签到返回 Turnstile 相关错误

目标 New API 站点可能对 `POST /api/user/checkin` 强制启用了 Turnstile。后端定时任务无法像浏览器用户一样完成交互校验，需要目标站点配合提供机器签到接口，或对受信任机器调用关闭该接口的 Turnstile 校验。

### 存储空间增长太快

当前默认保留最近 `7` 天日志。可以在 `wrangler.toml` 修改：

```toml
LOG_RETENTION_DAYS = "3"
```

修改后重新部署：

```bash
npm run deploy
```

Deno Deploy 则在环境变量里修改 `LOG_RETENTION_DAYS`。

### 改定时执行时间

Cloudflare Cron 使用 UTC 时间。北京时间比 UTC 快 8 小时。

例如北京时间每天 `08:00`：

```toml
crons = ["0 0 * * *"]
```

修改后重新部署：

```bash
npm run deploy
```

## 安全建议

- 不要把真实后台密码写进 README 或提交到 Git。
- 优先使用 `ADMIN_PASSWORD_HASH`，避免直接存储后台明文密码。
- New API 的系统访问令牌目前保存在 D1 中，建议只部署在自己的 Cloudflare 账号下。
- 如果需要更高安全性，可以继续扩展为加密存储 `access_token`。
- 不建议公开分享 Worker 管理台地址。

## 维护命令

查看 D1 列表：

```bash
npx wrangler d1 list
```

查看 Worker 部署记录：

```bash
npx wrangler deployments list
```

重新部署：

```bash
npm run deploy
```

线上执行 SQL 文件：

```bash
npx wrangler d1 execute newapi-checkin-db --remote --file=./schema.sql
```
