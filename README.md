# 🍗 疯狂星期四文案网站（Cloudflare Workers）

打开网页随机甩你一条「疯狂星期四」文案——还带分享图片、文案库搜索、免费随机文案 API。
所有文案都存在仓库里的一个纯文本文件 **[`quotes.txt`](./quotes.txt)**：在 GitHub 网页上改一行、保存，Cloudflare 自动重新构建上线，**不用写代码、不用本地环境、不用数据库**。

- 🎲 随机一条：`https://<你的域名>/`
- ⚡ 随机文案 API：`GET /api/random`（还有 10 个接口，见下方文档）
- 📅 每日一条：`GET /api/daily`
- 📖 OpenAPI 描述：`GET /api/openapi.json`

---

## ✨ 功能一览

**页面**

| 功能 | 说明 |
| --- | --- |
| 🎲 进站随机一条 | 每次打开/刷新/按空格都是新的一条 |
| 📅 今日固定 | 勾选后按北京时间当天固定，全站同一天同一条 |
| 🖼 一键生成分享图 | Canvas 实时画 1080×1350 竖版卡片，保存发群（含编号与站点域名） |
| 📚 文案库 | 全部文案列表、关键词搜索、标签筛选、滚动加载、点任意一条直接抽到该条 |
| 🍗 笑到了 / 🔥 热门 | 给梗点赞（同一浏览器同一条只算一次），绑定 KV 后出现「热门」榜 |
| 🔐 后台管理 | `/admin` 密码登录，查看 / 修改 / 清零点赞数（密码存于 `ADMIN_PASSWORD`） |
| 🔗 直达链接 | `/?id=42` 打开第 42 条，方便分享 |
| 📋 复制 / 系统分享 | 一键复制文案或链接，手机上走系统分享面板 |
| 🔥 星期四彩蛋 | 周四当天标题变「就在今天」，撒炸鸡/薯条彩带动画；其他日子显示倒计时 |
| 🌙 深色模式 | 跟随系统 |
| 📱 PWA | 可安装到手机桌面，离线也能看（Service Worker 缓存页面骨架，API 始终走网络） |
| ⌨️ 快捷键 | 空格换一条、`C` 复制、`L` 进文案库 |

**API**（全部 `GET`、CORS `*`、免费无 key）

| 接口 | 说明 |
| --- | --- |
| `/api/random` | 随机一条；支持 `?n=3` 批量、`?format=text` 纯文本、`?format=js&callback=cb` JSONP、`?seed=abc` 定种、`?tag=emo` 标签筛选 |
| `/api/daily` | 今天（北京时间）固定那一条，可 `?date=2026-11-05` |
| `/api/quote?id=42` | 指定文案 + 前后条 id |
| `/api/all` | 全部文案，支持 `?q=` 搜索、`?tag=`、`?page=`/`?limit=` 分页、`?shuffle=1` 洗牌 |
| `/api/search?q=炸鸡` | 关键词搜索（多词 AND，含标签匹配） |
| `/api/tags` | 标签及数量 |
| `/api/count` | 文案总数 + 构建时间 + 今天是不是星期四 |
| `/api/health` | 健康检查 |
| `/api/openapi.json` | OpenAPI 3.0 描述 |
| `GET /api/likes?id=42` | 读取某条文案的「🍗 笑到了」数量 |
| `POST /api/react?id=42` | 点「🍗 笑到了」+1（零配置可用；绑定 KV 后变成全局永久计数） |
| `/api/stats` | 热门排行（绑定 KV 后可用） |
| `GET /api/admin/status` | 后台是否启用、当前是否已登录 |
| `POST /api/admin/login` | 用 `ADMIN_PASSWORD` 换一个 12 小时有效的会话 cookie |
| `POST /api/admin/logout` | 退出登录 |
| `GET /api/admin/likes` | 全部点赞记录（需登录） |
| `POST /api/admin/likes-set` | 直接设定某条点赞数 `{id, likes}`（需登录） |
| `POST /api/admin/likes-delete` | 清零某一条 `{id}`（需登录） |
| `POST /api/admin/likes-reset` | 全部清零 `{confirm:true}`（需登录） |

**自动化**

- ⏰ 每周四 09:00（北京时间）Cron 触发，配置了 `WEBHOOK_URL` 就自动推一条文案（支持 Server酱 / 企业微信 / Bark / 自定义 JSON）。

## 📁 目录结构

```
crazy-thursday/
├── quotes.txt              ← ⭐ 文案库，只改这个文件就能加/删文案
├── src/
│   ├── index.js            ← Worker 入口：11 个 API 路由 + 静态资源 + Cron
│   └── core.js             ← 纯逻辑：解析 quotes.txt、随机/每日/搜索/洗牌（可在 Node 里单测）
├── public/
│   ├── index.html          ← 页面（内联 CSS/JS，零构建步骤）
│   ├── admin/index.html    ← 后台管理页（/admin）
│   ├── manifest.webmanifest / sw.js / icons/ / og.png   ← PWA 与分享图
├── scripts/test.mjs        ← 零依赖自测：node scripts/test.mjs
├── .github/workflows/deploy.yml ← 可选：用 GitHub Actions 部署（默认关闭）
├── wrangler.jsonc          ← Cloudflare Workers 配置
└── CREDITS.md              ← 文案数据来源与致谢
```

## 🧩 文案文件格式（`quotes.txt`）

```text
# 以 # 开头是注释，不会显示
今天天气不错，V我50，我去买份吮指原味鸡。 #经典 #求人
!这条暂时下线：文件里还在，但网站和 API 都不会出现
```

规则：**一行一条** · `#` 注释 · `!` 临时下线 · 行尾 `#标签` · 空行忽略 · 自动去重。
编号 `id` 按顺序生成，所以**新文案建议追加到末尾**（在中间插入会让后面所有 id 变化，之前分享过的 `/?id=` 链接会指向别的文案）。

## 🚀 本地开发

```bash
npm install
npm run dev      # http://localhost:8787
npm test         # 29 项自测：解析规则 / 随机 / 每日 / 搜索 / 数据完整性
```

> 国内镜像下 `wrangler dev` 可能因 `workerd` 二进制版本落后报 `Expected "..." but got "..."`，删掉 `node_modules` 改用官方源重装即可：`npm i --registry=https://registry.npmjs.org`。线上部署不需要本地 workerd。

## ☁️ 部署到 Cloudflare Workers（推荐路线）

1. 把本仓库推到 GitHub（用模板的话换成你自己的仓库）。
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository** → 选中本仓库 → 授权 GitHub。
3. 构建配置（Cloudflare 会自动识别）：
   - Deploy command: `npx wrangler deploy`
   - Root directory: 仓库根目录
4. 保存 → 自动构建上线，得到 `https://crazy-thursday.<你的子域>.workers.dev`。
5. 之后 **每次 push 到 main 都会自动重新部署** —— 改 `quotes.txt` 保存即生效，通常 30 秒左右。

### 关于「🍗 笑到了」点赞（可选升级到 KV）

**不用任何配置就能点**：没绑定 KV 时，计数走 Cloudflare 内置的 Cache API（每个数据中心各自计数、24 小时后自然过期，对玩笑性质的点赞足够用）。

想要**全局、永久的计数和热门排行榜**，再绑一个 KV：

1. 控制台 → **Storage & Databases → KV** → Create namespace，命名随便（例如 `crazy-thursday-likes`）。
2. 打开 `wrangler.jsonc`，取消注释并把 id 填进去：
   ```jsonc
   "kv_namespaces": [{ "binding": "QUOTES_KV", "id": "<你的 namespace id>" }],
   ```
3. push 后自动切到 KV 模式，无需改代码。

### 🔐 管理后台 `/admin`

用来管理点赞：查看排行、把某条改成任意数字、清零单条或全部清零。

**1. 设置密码（只需一次）**

后台密码不写在代码里，用环境变量（Secret）：

- 控制台：Worker `crazy-thursday` → **Settings → Variables and Secrets** → **Add** → Type 选 **Secret**，Name 填 `ADMIN_PASSWORD`，Value 填你想用的密码 → 保存并重新部署
- 或命令行：`npx wrangler secret put ADMIN_PASSWORD`

**2. 打开 `https://你的域名/admin`**，输入密码即可。登录状态 12 小时有效，Cookie 为 `HttpOnly`（JS 读不到）。

**3. 能做什么**

| 操作 | 说明 |
| --- | --- |
| 查看列表 | 只列出「有点赞」的文案，按赞数排序，显示累计点赞 / 条数 / 文案总数 |
| 搜索 | 输入关键词按正文搜索；输入 `#42` 精确按编号找 |
| 修改 | 改数字后点「保存」，立即写入 KV，前台马上生效 |
| 清零 | 单条清零，或「全部清零」（会二次确认） |
| 退出 | 清除会话 cookie |

**安全说明**：密码错误返回 401 且登录接口每 IP 限 10 次/分钟；会话是 HMAC-SHA256 签名 + 12 小时过期，改密码即让所有旧会话失效；未设置 `ADMIN_PASSWORD` 时后台整体关闭（接口返回 503，前台功能不受影响）。

### 可选：每周四自动推送

```bash
npx wrangler secret put WEBHOOK_URL    # 你的机器人/通知 Webhook 地址
npx wrangler secret put WEBHOOK_TYPE   # serverchan | wecom | bark | json（默认 json）
```

### 备用方案：GitHub Actions

仓库内置 `.github/workflows/deploy.yml`：在 Settings → Secrets and variables → Actions 里加 Secret `CLOUDFLARE_API_TOKEN`（Workers Scripts: Edit）和 Variable `ENABLE_CF_DEPLOY=true` 即可（不设变量就不会触发）。用 Workers Builds 的话这个文件可以删掉。

## 🔌 API 用法示例

```bash
# 纯文本，适合 shell / 机器人
curl https://your-domain/api/random?format=text

# 一次来 3 条
curl "https://your-domain/api/random?n=3"

# 每天固定、同一个人问都是同一条
curl "https://your-domain/api/daily"
curl "https://your-domain/api/random?seed=user-42"
```

```js
const res = await fetch("https://your-domain/api/random");
const { id, text, tags } = await res.json();
console.log(id, text, tags);
```

```html
<!-- JSONP，跨域老办法 -->
<script>
function cb(d) { document.getElementById("q").textContent = d.text; }
</script>
<script src="https://your-domain/api/random?format=js&callback=cb"></script>
```

## 🛠 常见问题

- **为什么把 txt 打进 Worker？** 用 Wrangler 的 `rules: [{type:"Text"}]` 把 `quotes.txt` 作为文本模块打包，改文件即改数据，冷启动零 IO，也不用 KV/D1。
- **能放多少条？** Workers 免费版单次上传上限 3 MiB（gzip 后，现在约 90 KiB）。按每条平均 400 字节算还能再放两万多条；再多就该换 KV/D1 了。
- **多久生效？** Workers Builds 一次构建一般 30–60 秒。
- **文案版权？** 多为网络流传段子，仅作非商业展示；数据来源见 [CREDITS.md](./CREDITS.md)。你是作者不希望被收录，提 issue 删除。

## 📄 License

代码 MIT；文案数据版权归原作者（见 [CREDITS.md](./CREDITS.md)）。
