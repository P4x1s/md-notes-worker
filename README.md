# Markdown 记事本（Cloudflare Workers）

一个可直接运行、按 Typora 视觉风格打磨的云端记事本：登录保护、笔记列表、新建/编辑/删除、标题、Markdown 编辑/预览/分屏、自动保存与保存状态，数据持久化到 D1 并按用户隔离。

## 1. 方案概览

```
浏览器 SPA  ──同源 JSON API──▶  Cloudflare Worker
   │                                  │
   │  marked + DOMPurify               ├─ D1：users / notes / sessions
   │  （仅前端渲染 Markdown）           ├─ KV：登录/注册限流计数
   └──── Workers Static Assets ◀──────┴─ Secrets：SESSION_SECRET / INVITE_CODE
```

选择 Workers 而非 Pages 的原因：API、静态资源、鉴权与限流集中在一个部署单元，依赖最少。Markdown 原文入库、HTML 只在浏览器生成并消毒，不把不可信 HTML 写入服务端。

成品截图：`ui-final-auth.png`、`ui-final-light-preview.png`、`ui-final-split.png`、`ui-final-dark-preview.png`、`ui-final-dark-split.png`。

## 2. 已实现功能

| 类别 | 内容 |
| --- | --- |
| 账号 | 邀请码受控注册、登录、退出（服务端吊销会话）、刷新保持登录 |
| 笔记 | 列表（标题/摘要/更新时间）、搜索标题与摘要、打开任意记录、新建、编辑、删除 |
| 编辑 | 标题输入、编辑/预览/分屏实时预览、代码块一键复制、导出 `.md` 文件 |
| 保存 | 800ms 防抖自动保存、Ctrl+S 立即保存、状态提示、失败可重试、离开页提醒 |
| 界面 | Typora 风格：窄侧栏、居中纸张、精细 Markdown 排版、浅色/深色主题、侧栏收起、当前行高亮、字数与行数 |
| 持久化 | Cloudflare D1（SQLite），按 `user_id` 强制隔离 |
| 安全 | 密码哈希、签名会话 + 服务端登记、输入校验、XSS 防护、CSP、限流、统一错误处理 |

## 3. 项目结构

```
md-notes-worker/
├── src/
│   ├── index.js        # 入口：路由、安全响应头、SPA 兜底、异常处理
│   ├── auth.js         # PBKDF2、HMAC 会话、token 摘要
│   ├── db.js           # D1 数据访问（笔记查询带 user_id，会话登记）
│   ├── validate.js     # 输入校验、请求体大小限制、HttpError
│   ├── ratelimit.js    # KV 固定窗口限流
│   └── http.js         # JSON 响应、Cookie 解析与写入、客户端 IP
├── public/
│   ├── index.html      # SPA 页面骨架
│   ├── app.js          # 鉴权/列表/搜索/自动保存/预览/分屏/导出
│   ├── style.css       # Typora 风格主题
│   └── vendor/         # 本地化依赖，配合严格 CSP，不依赖 CDN
│       ├── marked.min.js
│       └── purify.min.js
├── scripts/smoke-test.sh   # 本地端到端验证脚本
├── schema.sql          # D1 表结构
├── wrangler.toml       # D1 / KV / Assets 绑定
├── package.json
├── .dev.vars.example   # 本地密钥模板
├── .dev.vars           # 本地密钥（已 gitignore）
├── .gitignore
└── README.md
```

## 4. 数据模型

```sql
users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE,          -- 3-32 位字母数字下划线
  password_hash TEXT,            -- pbkdf2$迭代次数$salt$hash
  created_at INTEGER
)

notes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,      -- 外键 → users.id，级联删除
  title TEXT,                    -- ≤ 200 字符
  content TEXT,                  -- Markdown 原文，≤ 200 KB
  created_at INTEGER,
  updated_at INTEGER             -- 列表排序依据
)

sessions (
  token_hash TEXT PRIMARY KEY,   -- Cookie 的 SHA-256 摘要，不存原文
  user_id INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER
)
CREATE INDEX idx_notes_user_updated ON notes(user_id, updated_at DESC);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

隔离策略：服务端从已验签会话取 `user_id`（不信任客户端传参），所有笔记 SQL 均带 `WHERE id = ? AND user_id = ?`。跨用户 ID 返回 404，不暴露“存在但无权”信息。

## 5. 核心实现

### 5.1 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册（需邀请码，若已配置）并自动登录 |
| POST | `/api/auth/login` | 登录，下发会话 Cookie 并登记会话 |
| POST | `/api/auth/logout` | 删除服务端会话登记并清除 Cookie，旧 Cookie 立即失效 |
| GET | `/api/auth/me` | 恢复当前登录态 |
| GET | `/api/notes` | 当前用户笔记摘要列表 |
| POST | `/api/notes` | 新建笔记 |
| GET | `/api/notes/:id` | 读取单条笔记 |
| PUT | `/api/notes/:id` | 更新标题/内容（自动保存调用） |
| DELETE | `/api/notes/:id` | 删除笔记 |

统一返回 `{ ok: true, data }` / `{ ok: false, error: { code, message } }`。

### 5.2 鉴权

- 密码：`crypto.subtle` PBKDF2-SHA256，10 万次迭代 + 16 字节随机盐，常量时间比较。
- 用户不存在时执行一次等成本派生，降低用户名枚举的时序差异。
- 会话：`base64url(payload).base64url(HMAC-SHA256)`，负载含 `sub/u/iat/exp`，用 `crypto.subtle.verify` 验签；有效期 7 天。
- 服务端登记：只存 Cookie 的 SHA-256 摘要；每次鉴权查 `sessions` 表，登出即删记录，因此登出后旧 Cookie 不能继续使用。登录时顺带清理过期登记。
- Cookie：`HttpOnly` + `SameSite=Lax` + 始终 `Secure` + `Path=/` + `Max-Age`；前端 JS 无法读取。

### 5.3 自动保存与编辑

输入框 `input` 事件标记待保存并重置 800ms 定时器；到期调用 `PUT /api/notes/:id`。保存串行化，成功更新列表摘要与时间戳，失败保留待保存状态并可点击重试。切换笔记/登出时先冲刷未保存内容，`beforeunload` 做离开提示。

分屏模式下源码与渲染结果并排，输入即刷新右侧预览；预览区每个代码块带悬停显示的复制按钮；「导出」把当前笔记保存为 `<标题>.md`。

### 5.4 Markdown XSS 防护（纵深）

1. 服务端只存 Markdown 原文，不接收、不拼接、不返回 HTML。
2. 浏览器端 `marked.parse()` 生成 HTML 后立即 `DOMPurify.sanitize()`（HTML profile，禁用 `style/form/input/iframe/object/embed` 等标签与 `style` 属性）。
3. DOMPurify 钩子把 `<a>` 统一加上 `target="_blank"` 与 `rel="noopener noreferrer"`。
4. Worker 全局 CSP：`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'`，即使消毒被绕过，内联脚本也无法执行。
5. 笔记标题/摘要使用 `textContent` 渲染，不进入 `innerHTML`。

### 5.5 限流与错误处理

- KV 固定窗口：登录 10 次/分钟、注册 5 次/小时（按 `CF-Connecting-IP`），超限返回 429 + `Retry-After`。KV 故障时放行并记录日志，避免锁死登录。
- 请求体校验：`Content-Length` 与实际字节双重限制 256 KB；笔记内容 200 KB、标题 200 字符。
- 统一 `try/catch`：业务错误返回对应 4xx，未知异常只返回 500 通用文案，堆栈仅写服务端日志。

## 6. 本地运行

前置：Node.js ≥ 22.12（wrangler v4 要求）。

```bash
cd md-notes-worker
npm install
# .dev.vars 已提供本地随机密钥；如需自定义，按 .dev.vars.example 修改
npm run db:init:local
npm run dev
```

打开 `http://localhost:8787`，切换到“注册”，邀请码取 `.dev.vars` 中的 `INVITE_CODE`（当前本地值为 `uPHY8jyN_KK5LljJ`）。

> `.dev.vars` 含本地密钥，已加入 `.gitignore`。部署前必须重新生成生产密钥，不要复用本地值。

## 7. 部署要点

> 完整的从零部署图文步骤（含 API Token 权限、GitHub Secrets、两种部署方式、验证清单与排错）见 **[DEPLOY.md](./DEPLOY.md)**。下面是指令速查。

1. 创建资源并回填 `wrangler.toml`：
   ```bash
   npx wrangler d1 create md-notes-db
   npx wrangler kv namespace create RATE_LIMIT
   ```
   把输出的 `database_id` / `id` 替换掉文件中的占位 UUID。
2. 初始化远端表（含 `sessions`）：`npm run db:init:remote`
3. 写入密钥（不要写进 `wrangler.toml` 或代码仓库）：
   ```bash
   npx wrangler secret put SESSION_SECRET   # 随机 ≥32 字符
   npx wrangler secret put INVITE_CODE
   ```
4. 部署：`npm run deploy`。脚本固定带 `--keep-vars` —— `wrangler deploy` 默认会清空 Dashboard 上的变量，不带该参数会丢配置。
5. 端到端验证：打开 `<worker>.workers.dev`，完成注册 → 新建 → 编辑 → 刷新确认内容与登录态保留 → 退出后用旧会话确认 401 → 预览确认 Markdown 渲染。不要只以“部署命令成功”为准。

## 8. 安全设计汇总

| 风险 | 措施 | 边界 / 说明 |
| --- | --- | --- |
| 未授权访问 | 全部笔记接口校验签名会话 + 服务端登记 | 过期或已登出会话立即失效 |
| 越权读取/篡改 | SQL 层强制 `user_id` 条件 | 跨用户返回 404 |
| 密码泄露 | PBKDF2 + 随机盐 + 常量时间比较 | 生产必须强随机 `SESSION_SECRET` |
| 会话伪造/窃取 | HMAC 验签、HttpOnly、Secure、SameSite=Lax、库内只存摘要 | 支持单会话吊销，不做全设备强制登出 |
| 注册滥用 | 邀请码 + 按 IP 限流 | KV 最终一致性，限流为近似计数 |
| Markdown XSS | DOMPurify + 本地依赖 + CSP | CSP 的 `style-src` 含 `unsafe-inline` |
| 超大请求 | Content-Length + 实际字节双重校验 | 单笔记 200 KB |
| 信息泄露 | 通用错误文案、堆栈不入响应 | 日志保留在 Worker |
| 密钥泄漏 | `.dev.vars` gitignore + Dashboard secret | 提交前需再次扫描仓库 |

## 9. MVP 边界与后续建议

当前刻意不做：邮件验证/密码找回、Turnstile 人机验证、细粒度角色、版本历史、附件上传、精确限流（Durable Objects）、完整行内所见即所得编辑。

已完成的迭代项：会话服务端吊销、笔记搜索、分屏实时预览、Markdown 导出、代码块复制。

按优先级建议继续：Turnstile 接入注册/登录 → 版本历史与回收站 → 富文本行内编辑。

## 10. 界面说明（Typora 风格）

视觉参照 Typora：左侧 258px 文件栏（选中项左侧蓝线）、顶部搜索框、中间最大 880px 的居中纸张、34px 大标题与细分割线、标题下划线、引用块灰底竖线、代码块浅底圆角、底部 30px 状态栏。默认浅色纸张，右上角「深色/浅色」一键切换并写入 `localStorage`；「侧栏」按钮可收起文件栏进入专注书写。

模式：编辑（源码 + 当前行高亮）、预览（Typora 式排版）、分屏（两者并排，输入即刷新）。完整行内所见即所需维护光标与富文本块的双向映射，风险高于收益，故未采用。

## 11. 验证结果

本地已实际运行验证：

- `bash scripts/smoke-test.sh`：23 项全部通过，覆盖 D1 初始化、双用户注册、未登录 401、新建、跨用户 404、列表隔离、编辑持久化、删除、静态资源、Cookie 属性、CSP，以及登出后旧 Cookie 失效、其他会话不受影响。
- 无头 Edge 端到端：登录、注册两篇笔记、搜索过滤（2 条→1 条）、分屏布局、代码块复制按钮、导出按钮、主题切换、字数/行数统计均验证通过；截图见 `ui-final-*.png`。
- Markdown 消毒：`<script>` / `onerror` / `javascript:` URL 均被清除，脚本未执行，标题正常渲染（`PWNED=0|SCRIPT=0|ONERROR=0|JSURL=0|H1=1`）。

验证过程中发现并修复两个真实缺陷：`ratelimit.js` 中 `count` 变量作用域错误导致注册/登录 500；分屏模式遗漏切换布局 class 导致并排布局未生效。
