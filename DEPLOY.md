# 部署到 Cloudflare（从零到可访问）

本项目采用 **Cloudflare Workers + D1 + KV** 架构，已托管在私有仓库：

> https://github.com/P4x1s/md-notes-worker

本手册假设你还没有配置任何 Cloudflare 资源，按步骤走完即可获得一个可访问的线上地址。全程约 15 分钟。

---

## 0. 两种部署方式，先选一条

| 方式 | 适用场景 | 你需要做的 |
| --- | --- | --- |
| **A. GitHub Actions 自动部署**（推荐） | 后续会持续改代码、希望 push 即上线 | 配置 4 个 GitHub Secrets + 改一次 `wrangler.toml` |
| **B. 本地 wrangler 部署** | 只想上线一次、不想配置 CI | 本地装 wrangler、登录、执行 3 条命令 |

两种方式共用同一套 Cloudflare 资源（D1 / KV / Secret），只是"谁来执行 `wrangler deploy`"不同。下面先讲**共用准备工作**（第 1–4 步），再分叉。

---

## 1. 获取 Cloudflare Account ID

1. 登录 https://dash.cloudflare.com
2. 右侧栏或任一 Worker 页面 URL 中会看到一串 32 位十六进制字符，那就是 **Account ID**
3. 记下来，后续两处要用

## 2. 创建 API Token（给 Actions / wrangler 用）

进入 **My Profile → API Tokens → Create Token**，建议用 **Edit Cloudflare Workers** 模板，然后追加以下权限（最小权限原则）：

| 权限组 | 资源 | 权限 |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Workers KV Storage | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |

- Token TTL 建议设为 90 天或自定义；看到一次明文后请妥善保存
- 不要用 Global API Key（权限过大）

## 3. 创建 D1 数据库与 KV 命名空间

在 Cloudflare Dashboard 中：

**D1**：`Workers & Pages → D1 → Create database`
- 名称填 `md-notes-db`
- 创建后复制 **Database ID**（形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）

**KV**：`Workers & Pages → KV → Create namespace`
- 名称填 `md-notes-ratelimit`
- 创建后复制 **Namespace ID**

> 这两个 ID 要写进 `wrangler.toml`，见第 5 步。

## 4. 生成应用运行时密钥

在本地执行（或用任意密码生成器）：

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"   # SESSION_SECRET
python -c "import secrets; print(secrets.token_urlsafe(18))"   # ADMIN_PASSWORD
```

- `SESSION_SECRET`：用于签名会话 Cookie，至少 32 字符，**泄露即可伪造登录态**
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`：**单用户登录凭证**。应用没有注册功能，只有这一个账号；两个值都配置在 Worker 的 Variables and Secrets 里，随时可改，改后立即生效
- `ADMIN_PASSWORD` 建议不少于 8 字符的随机串

这三个值属于**应用运行时 secret**，必须配置在 Cloudflare Worker 上（见第 6 步），**不要写进代码或 `wrangler.toml`**。

---

## 5. 修改 wrangler.toml（关键步骤）

仓库里的 `wrangler.toml` 目前是**占位 ID**，直接部署会失败。把第 3 步拿到的真实 ID 填进去：

```toml
[[d1_databases]]
binding = "DB"
database_name = "md-notes-db"
database_id = "替换为你自己的 Database ID"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "替换为你自己的 Namespace ID"
```

修改方式二选一：
- **网页改**：在 GitHub 仓库页面直接编辑 `wrangler.toml` → Commit changes（会触发 Actions）
- **本地改**：clone 后本地修改、commit、push

Worker 名称在 `name = "md-notes-demo"` 处，可改成你喜欢的名字；部署后访问地址是 `https://<name>.<你的子域>.workers.dev`。

---

## 6. 配置 Worker 运行时 Secret（两处 secret 不要混淆）

这是最容易踩坑的地方，请仔细区分：

| Secret | 放哪里 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | **GitHub 仓库 Secrets** | 让 Actions 有权限部署到 Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | **GitHub 仓库 Secrets** | 让 Actions 知道部署到哪个账号 |
| `SESSION_SECRET` | **Cloudflare Worker 运行时**（Dashboard 或 `wrangler secret put`） | 应用签名 Cookie |
| `ADMIN_USERNAME` | **Cloudflare Worker 运行时** | 单用户登录用户名 |
| `ADMIN_PASSWORD` | **Cloudflare Worker 运行时** | 单用户登录密码 |

> Actions deploy **不会**把 GitHub Secrets 自动变成 Worker 运行时变量，所以后三个必须单独加到 Worker 上。

**加 GitHub Secrets**：仓库 → Settings → Secrets and variables → Actions → New repository secret，添加：
- `CLOUDFLARE_API_TOKEN` = 第 2 步的 token
- `CLOUDFLARE_ACCOUNT_ID` = 第 1 步的 Account ID

**加 Worker 运行时 Secret**（二选一）：
- Dashboard：Worker → Settings → Variables and Secrets → Add secret，依次添加 `SESSION_SECRET`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`
- 本地 wrangler：`wrangler secret put SESSION_SECRET`，然后粘贴值回车（三个同理）

---

## 7A. 方式 A：GitHub Actions 自动部署

仓库自带 `.github/workflows/deploy.yml`，push 到 `main` 或手动触发都会执行：

```
Apply D1 schema  →  wrangler deploy --keep-vars
```

1. 确认第 5、6 步已完成
2. 在仓库 **Actions** 页找到 "Deploy Worker"，点 **Run workflow**（或直接 push 一次）
3. 等待执行完成，绿色勾表示成功

> workflow 已固定使用 `--keep-vars`。这是必需的：`wrangler deploy` 默认会删除 Dashboard 上配置的所有变量和 secret，不加这个参数会把第 6 步的 `SESSION_SECRET` / `ADMIN_USERNAME` / `ADMIN_PASSWORD` 清掉。

## 7B. 方式 B：本地 wrangler 部署

```bash
cd md-notes-worker
npm install
npx wrangler login              # 浏览器授权
npx wrangler d1 execute md-notes-db --remote --file=./schema.sql
wrangler secret put SESSION_SECRET    # 粘贴第 4 步生成的值
wrangler secret put ADMIN_USERNAME
wrangler secret put ADMIN_PASSWORD
npm run deploy                  # 已内置 --keep-vars
```

> `wrangler` v4 要求 Node.js ≥ 22.12，本地 Node 版本过低会报 "requires at least Node.js v22.12"。

---

## 8. 端到端验证部署是否真正生效

部署成功后，浏览器打开 `https://<worker-name>.<subdomain>.workers.dev`。按下面清单逐项确认——**"push 成功"不等于"线上已更新"**，必须实测：

- [ ] 登录页正常显示，Typora 风格样式加载（说明静态资源绑定 OK）
- [ ] 用第 4/6 步配置的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录成功
- [ ] 故意输错一次密码，提示"用户名或密码错误"（说明校验生效）
- [ ] 新建笔记、输入 Markdown、切换预览，等待 1 秒后刷新页面内容仍在（说明 D1 持久化 OK）
- [ ] 退出登录，用浏览器后退再进——仍要求登录（说明会话吊销 OK）
- [ ] 浏览器 DevTools → Network → 响应头中有 `Content-Security-Policy`、`HttpOnly` 的 `Set-Cookie`（说明安全头与 Cookie 配置 OK）

如登录报 500，多半是 D1 schema 没应用或 `SESSION_SECRET` / `ADMIN_USERNAME` / `ADMIN_PASSWORD` 未配置；如提示"用户名或密码错误"，是 Worker 上的凭证值与输入不一致。

---

## 9. 常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| Actions 报 9109 Authentication error | GitHub Secret `CLOUDFLARE_API_TOKEN` 失效或权限不足，换 token 后 rerun |
| 部署后登录全部 500 | Worker 运行时缺 `SESSION_SECRET` / `ADMIN_USERNAME` / `ADMIN_PASSWORD`；或 D1 schema 未应用 |
| 登录正常但刷新后掉线 | 浏览器阻止了 `Secure` Cookie（本地 http 环境会这样，线上 https 正常） |
| 改了代码但线上没变 | 检查 Actions 是否真跑到 deploy 步；用线上页面特征串确认，别只看 push 状态 |
| 登录接口 429 | KV 限流生效（10 次/分钟/IP），等下一窗口或换 IP |
| Worker 想改名 | Cloudflare 无原生 rename：新建同名 Worker → 验证 → 删旧的；workers.dev 域名会变 |

---

## 10. 后续运维

- **改登录用户名 / 密码**：Dashboard → Worker → Settings → Variables and Secrets 更新 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，保存后立即生效，无需重新 deploy（旧会话仍有效；要强制下线可同时轮换 `SESSION_SECRET`）
- **轮换 SESSION_SECRET**：更新后会强制重新登录
- **备份数据**：D1 控制台可导出 SQLite；定期备份是好习惯
- **本地开发**：`npm run dev`，本地凭证在 `.dev.vars`（该文件已 gitignore，不会上传）
