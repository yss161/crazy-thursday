import RAW_QUOTES from "../quotes.txt";
import {
  parseQuotes, parseAll, formatLine, pickRandom, pickBySeed, pickMany, shuffle,
  filterByTag, searchQuotes, tagIndex, beijingDate, isThursday, daysUntilThursday, truncate,
} from "./core.js";

const QUOTES = parseQuotes(RAW_QUOTES);
// 注意：Workers 在脚本启动阶段 Time 被冻结为 0，因此这里懒计算（≈ 首次请求 / 部署时间）
let _builtAt = "";
const builtAt = () => _builtAt || (_builtAt = new Date().toISOString());
const VERSION = "1.2.0";

/* ---------------------------------- 工具 ---------------------------------- */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...(init.headers || {}) },
  });
}
function text(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS, ...(init.headers || {}) },
  });
}
function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status });
}
function intParam(url, name, def, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null) return def;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}
function brief(q) {
  return { id: q.id, text: q.text, tags: q.tags };
}

/* ------------------------ 简易限流（每 isolate 内存） ------------------------ */
// 说明：Workers 无共享内存，这只是「单个 isolate 内」的节流，用于挡住脚本刷接口。
// 想要跨全网的严格限流，请在控制台给 Worker 绑定 Rate Limiting 规则或 KV。
const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n++;
  if (buckets.size > 5000) buckets.clear();
  buckets.set(key, b);
  return b.n > limit;
}


/* ------------------------- 「笑到了」计数存储层 ------------------------- */
// 优先用 KV（全局、永久）；没绑定时退化为 Cache API（无需任何配置，
// 每个 Cloudflare 数据中心各自计数、24 小时后过期，对玩笑性质的点赞足够用）。

const CACHE_TTL = 86400;
function likesKey(id) {
  return "https://likes.internal/crazy-thursday/" + id;
}

async function readLikes(env, id) {
  const kv = env && env.QUOTES_KV;
  if (kv) return { likes: Number(await kv.get("likes:" + id)) || 0, mode: "kv" };
  if (typeof caches === "undefined") return { likes: 0, mode: "none" };
  try {
    const hit = await caches.default.match(new Request(likesKey(id)));
    return { likes: hit ? Number(await hit.text()) || 0 : 0, mode: "cache" };
  } catch {
    return { likes: 0, mode: "none" };
  }
}

async function bumpLikes(env, id) {
  const kv = env && env.QUOTES_KV;
  if (kv) {
    const cur = Number(await kv.get("likes:" + id)) || 0;
    await kv.put("likes:" + id, String(cur + 1));
    return { likes: cur + 1, mode: "kv" };
  }
  if (typeof caches === "undefined") return { likes: 0, mode: "none" };
  const { likes } = await readLikes(env, id);
  const next = likes + 1;
  try {
    await caches.default.put(
      new Request(likesKey(id)),
      new Response(String(next), {
        headers: { "content-type": "text/plain", "cache-control": "max-age=" + CACHE_TTL },
      })
    );
  } catch {
    return { likes, mode: "none" };
  }
  return { likes: next, mode: "cache" };
}


/* ------------------------------ 管理后台鉴权 ------------------------------ */
// 密码来自环境变量 ADMIN_PASSWORD（Cloudflare Secret）。
// 登录后下发 HMAC 签名的一次性会话 cookie，无需数据库。

const SESSION_TTL = 60 * 60 * 12; // 12 小时

function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function adminPassword(env) {
  return (env && env.ADMIN_PASSWORD) || "";
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

async function issueSession(env) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
  const sig = await hmacHex(adminPassword(env), "admin:" + exp);
  return { token: exp + "." + sig, maxAge: SESSION_TTL };
}

async function isAuthed(request, env) {
  const pw = adminPassword(env);
  if (!pw) return false;
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const token = bearer || readCookie(request, "admin_session");
  if (!token || !token.includes(".")) return false;
  const [exp, sig] = token.split(".");
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
  const expect = await hmacHex(pw, "admin:" + exp);
  return timingSafeEqual(sig, expect);
}

function requireAdmin(request, env) {
  const pw = adminPassword(env);
  if (!pw) return fail("后台未启用：请在 Cloudflare 控制台给 Worker 添加环境变量 ADMIN_PASSWORD", 503, { enabled: false });
  return null;
}

/** 读取全部点赞记录（KV），附带文案正文 */
async function listAllLikes(env) {
  const kv = env && env.QUOTES_KV;
  if (!kv) return null;
  const listing = await kv.list({ prefix: "likes:", limit: 1000 });
  const rows = await Promise.all(
    listing.keys.map(async (k) => {
      const id = Number(k.name.slice(6));
      const likes = Number(await kv.get(k.name)) || 0;
      const q = QUOTES.find((x) => x.id === id);
      return { id, likes, text: q ? q.text : "(这条文案已不存在)", tags: q ? q.tags : [] };
    })
  );
  rows.sort((a, b) => b.likes - a.likes || a.id - b.id);
  return { rows, total: rows.reduce((s, r) => s + r.likes, 0) };
}


/* --------------------------- GitHub 文案文件读写层 --------------------------- */
// 后台对「已有文案」的增删改，都是直接改仓库里的 quotes.txt（唯一数据源）。
// 需要的环境变量：GITHUB_TOKEN（Secret，fine-grained PAT，Contents: Read and write）

const B64 = {
  encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(bin);
  },
  decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  },
};

function ghCfg(env) {
  return {
    token: (env && env.GITHUB_TOKEN) || "",
    repo: (env && env.GITHUB_REPO) || "yss161/crazy-thursday",
    branch: (env && env.GITHUB_BRANCH) || "main",
    file: (env && env.GITHUB_FILE) || "quotes.txt",
    api: ((env && env.GITHUB_API_BASE) || "https://api.github.com").replace(/\/$/, ""),
  };
}

async function ghFetch(env, pathname, init = {}) {
  const cfg = ghCfg(env);
  return fetch(cfg.api + "/repos/" + cfg.repo + "/contents/" + encodeURIComponent(cfg.file) + pathname, {
    ...init,
    headers: {
      Authorization: "Bearer " + cfg.token,
      Accept: "application/vnd.github+json",
      "User-Agent": "crazy-thursday-admin",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

/** 读取仓库里的文案文件：{ content, sha } */
async function ghRead(env) {
  const cfg = ghCfg(env);
  if (!cfg.token) return { error: fail("未配置 GITHUB_TOKEN：请在 Cloudflare → Worker → Settings → Variables and Secrets 里添加 Secret GITHUB_TOKEN 后再试", 503) };
  const res = await ghFetch(env, "?ref=" + encodeURIComponent(cfg.branch), { method: "GET" });
  if (res.status === 404) return { error: fail("仓库里找不到 " + cfg.file + "（检查 GITHUB_REPO / GITHUB_FILE 变量）", 404) };
  if (!res.ok) {
    const t = await res.text();
    const hint = res.status === 401 || res.status === 403 ? "：GITHUB_TOKEN 无效、过期或权限不足（需要 Contents: Read and write）" : "";
    return { error: fail("读取 " + cfg.file + " 失败（GitHub " + res.status + "）" + hint + " " + t.slice(0, 160), 502) };
  }
  const data = await res.json();
  return { content: B64.decode(data.content || ""), sha: data.sha };
}

/** 写入文案文件，sha 不匹配时返回 { conflict: true } 由上层重试 */
async function ghWrite(env, content, sha, message) {
  const cfg = ghCfg(env);
  const res = await ghFetch(env, "", {
    method: "PUT",
    body: JSON.stringify({ message, content: B64.encode(content), sha, branch: cfg.branch }),
  });
  if (res.status === 409 || res.status === 422) return { conflict: true };
  if (!res.ok) {
    const t = await res.text();
    return { error: fail("写入 " + cfg.file + " 失败（GitHub " + res.status + "）：" + t.slice(0, 160), 502) };
  }
  const data = await res.json();
  return { ok: true, sha: data.content && data.content.sha, commit: data.commit && data.commit.sha, message };
}

/** 读文件 -> 改行 -> 写回，自动处理并发冲突（重试一次） */
async function ghMutate(env, buildMessage, mutator) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await ghRead(env);
    if (file.error) return file.error;
    const lines = file.content.split("\n");
    const items = parseAll(file.content);
    const out = mutator(lines, items);
    if (out && out.__response) return out.__response;
    const next = lines.join("\n");
    if (next === file.content) return json({ ok: true, changed: false, sha: file.sha, note: "内容没有变化" }, { headers: { "cache-control": "no-store" } });
    const put = await ghWrite(env, next, file.sha, typeof buildMessage === "function" ? buildMessage(out) : buildMessage);
    if (put.conflict) continue;
    if (put.error) return put.error;
    return json(
      { ok: true, sha: put.sha, commit: put.commit, note: "已提交，Cloudflare 会在 1~2 分钟内完成构建上线" },
      { headers: { "cache-control": "no-store" } }
    );
  }
  return fail("文件刚刚被别处修改过，请刷新后台后重试", 409);
}

const hiddenMark = (line) => (line.trimStart().startsWith("!") ? line : "!" + line.replace(/^\s+/, ""));

/* ------------------------------ 草稿箱（KV） ------------------------------ */
const DRAFTS_KEY = "drafts";

async function readDrafts(env) {
  const kv = env && env.QUOTES_KV;
  if (!kv) return null;
  const raw = await kv.get(DRAFTS_KEY);
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

async function writeDrafts(env, drafts) {
  const kv = env && env.QUOTES_KV;
  if (!kv) return false;
  await kv.put(DRAFTS_KEY, JSON.stringify(drafts));
  return true;
}

function nextDraftId(drafts) {
  let max = 0;
  for (const d of drafts) {
    const n = Number(String(d.id || "").replace(/^d/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return "d" + (max + 1);
}

/* --------------------------------- 路由 --------------------------------- */

const ROUTES = {
  /** 随机一条（或 n 条） */
  "/api/random": (url) => {
    const tag = url.searchParams.get("tag");
    const seed = url.searchParams.get("seed");
    const format = (url.searchParams.get("format") || "json").toLowerCase();
    const n = intParam(url, "n", 1, 1, 20);
    const pool = filterByTag(QUOTES, tag);

    const list = seed ? [pickBySeed(pool, seed)] : pickMany(pool, n);
    const first = list[0];

    if (format === "text" || format === "plain") {
      const body = list.map((q) => q.text).join("\n\n") + "\n";
      return text(body, { headers: { "cache-control": "no-store" } });
    }
    if (format === "js" || format === "jsonp") {
      const cb = (url.searchParams.get("callback") || "callback").replace(/[^\w$.]/g, "");
      const payload = { ok: true, id: first.id, text: first.text, tags: first.tags, total: pool.length, type: seed ? "seeded" : "random", quotes: list.map(brief) };
      return new Response(`${cb}(${JSON.stringify(payload)});`, {
        headers: { "content-type": "application/javascript; charset=utf-8", ...CORS, "cache-control": "no-store" },
      });
    }

    const payload = {
      ok: true,
      id: first.id,
      text: first.text,
      tags: first.tags,
      total: pool.length,
      type: seed ? "seeded" : "random",
      date: beijingDate(),
      isThursday: isThursday(beijingDate()),
    };
    if (n > 1) payload.quotes = list.map(brief);
    return json(payload, { headers: { "cache-control": "no-store" } });
  },

  /** 今天（北京时间）固定那一条 */
  "/api/daily": (url) => {
    const date = url.searchParams.get("date") || beijingDate();
    const pool = filterByTag(QUOTES, url.searchParams.get("tag"));
    const q = pickBySeed(pool, "daily:" + date);
    return json(
      {
        ok: true, date, id: q.id, text: q.text, tags: q.tags, total: pool.length, type: "daily",
        isThursday: isThursday(date), daysUntilThursday: daysUntilThursday(date),
      },
      { headers: { "cache-control": "public, max-age=300" } }
    );
  },

  /** 按 id 取某条 */
  "/api/quote": (url) => {
    const id = intParam(url, "id", 0, 0, 1e9);
    const q = QUOTES.find((x) => x.id === id);
    if (!q) return fail("quote not found", 404);
    const neighbours = {
      prev: id > 1 ? id - 1 : QUOTES.length,
      next: id < QUOTES.length ? id + 1 : 1,
    };
    return json({ ok: true, ...q, total: QUOTES.length, ...neighbours }, { headers: { "cache-control": "public, max-age=600" } });
  },

  /** 全部文案（支持搜索 / 标签 / 分页 / 洗牌） */
  "/api/all": (url) => {
    let pool = filterByTag(QUOTES, url.searchParams.get("tag"));
    pool = searchQuotes(pool, url.searchParams.get("q"));
    if (url.searchParams.get("shuffle")) pool = shuffle(pool);
    const total = pool.length;
    const limit = intParam(url, "limit", 500, 1, 2000);
    const page = intParam(url, "page", 1, 1, 1e6);
    const start = (page - 1) * limit;
    return json(
      { ok: true, total, page, limit, hasMore: start + limit < total, quotes: pool.slice(start, start + limit).map(brief) },
      { headers: { "cache-control": "public, max-age=60" } }
    );
  },

  /** 搜索 */
  "/api/search": (url) => {
    const q = url.searchParams.get("q") || "";
    const hits = searchQuotes(QUOTES, q);
    return json({ ok: true, q, total: hits.length, quotes: hits.slice(0, 200).map(brief) }, { headers: { "cache-control": "public, max-age=120" } });
  },

  /** 总数 */
  "/api/count": () =>
    json(
      { ok: true, count: QUOTES.length, builtAt: builtAt(), version: VERSION, date: beijingDate(), isThursday: isThursday(beijingDate()) },
      { headers: { "cache-control": "public, max-age=60" } }
    ),

  /** 标签统计 */
  "/api/tags": () => json({ ok: true, tags: tagIndex(QUOTES) }, { headers: { "cache-control": "public, max-age=300" } }),

  /** 健康检查 */
  "/api/health": () => json({ ok: true, quotes: QUOTES.length, builtAt: builtAt(), version: VERSION }),

  /** OpenAPI 描述（给 Postman / 代码生成用） */
  "/api/openapi.json": (url) => {
    const base = url.origin;
    const item = { type: "object", properties: { id: { type: "integer" }, text: { type: "string" }, tags: { type: "array", items: { type: "string" } } } };
    return json(
      {
        openapi: "3.0.3",
        info: { title: "疯狂星期四文案 API", version: VERSION, description: "随机返回一条肯德基疯狂星期四文案。文案内容来自仓库 quotes.txt。" },
        servers: [{ url: base }],
        paths: {
          "/api/random": { get: { summary: "随机一条（或 n 条）", parameters: [
            { name: "n", in: "query", schema: { type: "integer", default: 1, maximum: 20 }, description: "返回条数" },
            { name: "format", in: "query", schema: { type: "string", enum: ["json", "text", "js"] }, description: "返回格式" },
            { name: "tag", in: "query", schema: { type: "string" }, description: "按标签筛选" },
            { name: "seed", in: "query", schema: { type: "string" }, description: "种子，同一 seed 恒返回同一条" },
            { name: "callback", in: "query", schema: { type: "string" }, description: "format=js 时的回调名" },
          ], responses: { 200: { description: "成功", content: { "application/json": { schema: item } } } } } },
          "/api/daily": { get: { summary: "今天固定的一条", parameters: [{ name: "date", in: "query", schema: { type: "string" } }, { name: "tag", in: "query", schema: { type: "string" } }], responses: { 200: { description: "成功" } } } },
          "/api/quote": { get: { summary: "按 id 取", parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer" } }], responses: { 200: { description: "成功" }, 404: { description: "不存在" } } } },
          "/api/all": { get: { summary: "全部文案", parameters: [
            { name: "q", in: "query", schema: { type: "string" } }, { name: "tag", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer", default: 1 } }, { name: "limit", in: "query", schema: { type: "integer", default: 500 } },
            { name: "shuffle", in: "query", schema: { type: "boolean" } },
          ], responses: { 200: { description: "成功" } } } },
          "/api/search": { get: { summary: "关键词搜索", parameters: [{ name: "q", in: "query", schema: { type: "string" } }], responses: { 200: { description: "成功" } } } },
          "/api/count": { get: { summary: "总数与构建信息", responses: { 200: { description: "成功" } } } },
          "/api/tags": { get: { summary: "标签统计", responses: { 200: { description: "成功" } } } },
          "/api/health": { get: { summary: "健康检查", responses: { 200: { description: "成功" } } } },
          "/api/likes": { get: { summary: "读取某条文案的「笑到了」数量", parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer" } }], responses: { 200: { description: "成功" } } } },
          "/api/react": { post: { summary: "给某条文案点个「笑到了」（无需配置；绑定 KV 后升级为全局永久计数）", parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer" } }], responses: { 200: { description: "成功" }, 429: { description: "太频繁" } } } },
          "/api/stats": { get: { summary: "热门文案排行（绑定 KV 后可用）", responses: { 200: { description: "成功" } } } },
        },
      },
      { headers: { "cache-control": "public, max-age=3600" } }
    );
  },

  /** 读取某条文案的「笑到了」数量 */
  "/api/likes": async (url, request, env) => {
    const id = intParam(url, "id", 0, 0, 1e9);
    if (!QUOTES.some((q) => q.id === id)) return fail("quote not found", 404);
    const { likes, mode } = await readLikes(env, id);
    return json({ ok: true, id, likes, mode }, { headers: { "cache-control": "no-store" } });
  },

  /** 点个「笑到了」：KV 优先，未绑定 KV 时用 Cache API 兜底，因此无需任何配置就能用 */
  "/api/react": async (url, request, env) => {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (rateLimited("react:" + ip, 30, 60_000)) return fail("请求太频繁，歇会儿再来", 429);
    const id = intParam(url, "id", 0, 0, 1e9);
    if (!QUOTES.some((q) => q.id === id)) return fail("quote not found", 404);
    const { likes, mode } = await bumpLikes(env, id);
    return json({ ok: true, id, likes, mode }, { headers: { "cache-control": "no-store" } });
  },

  /** 热门排行（仅在绑定 KV 时可用，否则返回提示） */
  "/api/stats": async (url, request, env) => {
    const kv = env && env.QUOTES_KV;
    if (!kv) {
      return json({ ok: true, kv: false, mode: typeof caches !== "undefined" ? "cache" : "none", quotes: QUOTES.length, note: "未绑定 KV：点赞使用 Cache API 兜底，只计数不排行" });
    }
    const list = await kv.list({ prefix: "likes:", limit: 1000 });
    const rows = await Promise.all(list.keys.map(async (k) => ({ id: Number(k.name.slice(6)), likes: Number(await kv.get(k.name)) || 0 })));
    rows.sort((a, b) => b.likes - a.likes);
    const top = rows.slice(0, 20).map((r) => ({ ...brief(QUOTES.find((q) => q.id === r.id) || { id: r.id, text: "", tags: [] }), likes: r.likes }));
    return json({ ok: true, kv: true, mode: "kv", total: rows.reduce((s, r) => s + r.likes, 0), top }, { headers: { "cache-control": "no-store" } });
  },

  /* ---------------------------- 管理后台接口 ---------------------------- */
  "/api/admin/status": async (url, request, env) =>
    json({ ok: true, enabled: !!adminPassword(env), authed: await isAuthed(request, env) }, { headers: { "cache-control": "no-store" } }),

  "/api/admin/login": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (rateLimited("admin-login:" + ip, 10, 60_000)) return fail("尝试太频繁，请一分钟后再试", 429);
    let body = {};
    try { body = await request.json(); } catch {}
    if (!timingSafeEqual(String(body.password || ""), adminPassword(env))) {
      return fail("密码不正确", 401);
    }
    const { token, maxAge } = await issueSession(env);
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return json({ ok: true }, {
      headers: {
        "set-cookie": "admin_session=" + encodeURIComponent(token) + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=" + maxAge + secure,
        "cache-control": "no-store",
      },
    });
  },

  "/api/admin/logout": async (url, request, env) =>
    json({ ok: true }, {
      headers: {
        "set-cookie": "admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
        "cache-control": "no-store",
      },
    }),

  /** 点赞列表 */
  "/api/admin/likes": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    const all = await listAllLikes(env);
    if (!all) return fail("未绑定 KV，无法管理点赞", 503);
    return json({ ok: true, total: all.total, count: all.rows.length, rows: all.rows }, { headers: { "cache-control": "no-store" } });
  },

  /** 修改某条的点赞数（body: {id, likes}），likes=0 等价于清零 */
  "/api/admin/likes-set": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    const kv = env && env.QUOTES_KV;
    if (!kv) return fail("未绑定 KV，无法管理点赞", 503);
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.id);
    const likes = Number(body.likes);
    if (!Number.isInteger(id) || id < 1 || !QUOTES.some((q) => q.id === id)) return fail("文案 id 不存在", 400);
    if (!Number.isFinite(likes) || likes < 0 || likes > 1e9) return fail("点赞数必须是 0 ~ 10 亿之间的整数", 400);
    const key = "likes:" + id;
    if (likes === 0) await kv.delete(key);
    else await kv.put(key, String(Math.floor(likes)));
    return json({ ok: true, id, likes: Math.floor(likes) }, { headers: { "cache-control": "no-store" } });
  },

  /** 清零某一条 */
  "/api/admin/likes-delete": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    const kv = env && env.QUOTES_KV;
    if (!kv) return fail("未绑定 KV，无法管理点赞", 503);
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return fail("文案 id 无效", 400);
    await kv.delete("likes:" + id);
    return json({ ok: true, id, likes: 0 }, { headers: { "cache-control": "no-store" } });
  },

  /** 全部清零（body 必须带 confirm: true） */
  "/api/admin/likes-reset": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    const kv = env && env.QUOTES_KV;
    if (!kv) return fail("未绑定 KV，无法管理点赞", 503);
    let body = {};
    try { body = await request.json(); } catch {}
    if (body.confirm !== true) return fail("危险操作：请在请求体里带 confirm: true", 400);
    const listing = await kv.list({ prefix: "likes:", limit: 1000 });
    await Promise.all(listing.keys.map((k) => kv.delete(k.name)));
    return json({ ok: true, deleted: listing.keys.length }, { headers: { "cache-control": "no-store" } });
  },

  /* ------------------------- 文案管理（直接改 GitHub） ------------------------- */
  /** 概览：GitHub 连通性、文案统计、构建是否同步 */
  "/api/admin/overview": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    const cfg = ghCfg(env);
    const info = { githubConfigured: !!cfg.token, repo: cfg.repo, branch: cfg.branch, file: cfg.file, kv: !!(env && env.QUOTES_KV) };
    const file = await ghRead(env);
    if (file.error) {
      const body = await file.error.json().catch(() => ({}));
      return json({ ok: true, ...info, githubOk: false, githubError: body.error || "读取失败", builtCount: QUOTES.length }, { headers: { "cache-control": "no-store" } });
    }
    const items = parseAll(file.content);
    const live = items.filter((q) => !q.hidden).length;
    const drafts = (await readDrafts(env)) || [];
    return json({
      ok: true, ...info, githubOk: true,
      fileText: items.length, fileLive: live, fileHidden: items.length - live,
      builtCount: QUOTES.length, draftCount: drafts.length,
      synced: live === QUOTES.length,
    }, { headers: { "cache-control": "no-store" } });
  },

  /** 文案列表（读 GitHub 原文，支持搜索/过滤/分页） */
  "/api/admin/quotes": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    const file = await ghRead(env);
    if (file.error) return file.error;
    const all = parseAll(file.content);
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const filter = url.searchParams.get("filter") || "all";
    let rows = all;
    if (filter === "live") rows = rows.filter((r) => !r.hidden);
    else if (filter === "hidden") rows = rows.filter((r) => r.hidden);
    if (q) {
      rows = q.startsWith("#")
        ? rows.filter((r) => String(r.id) === q.slice(1))
        : rows.filter((r) => r.text.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)));
    }
    const total = rows.length;
    const limit = intParam(url, "limit", 50, 1, 200);
    const page = intParam(url, "page", 1, 1, 1e6);
    const start = (page - 1) * limit;
    const live = all.filter((r) => !r.hidden).length;
    return json({
      ok: true, total, page, limit, sha: file.sha,
      fileText: all.length, fileLive: live, fileHidden: all.length - live, builtCount: QUOTES.length,
      synced: live === QUOTES.length,
      rows: rows.slice(start, start + limit),
    }, { headers: { "cache-control": "no-store" } });
  },

  /** 新增一条 */
  "/api/admin/quotes-add": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    let body = {};
    try { body = await request.json(); } catch {}
    const text = String(body.text || "").trim();
    if (text.length < 2 || text.length > 1000) return fail("文案长度需要在 2~1000 字之间", 400);
    const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(/[\s,，]+/).filter(Boolean);
    const line = formatLine(text, tags, !!body.hidden);
    return ghMutate(env, (out) => (out.hidden ? "chore(quotes): 后台新增并下线一条文案" : "chore(quotes): 后台新增文案"), (lines, items) => {
      if (items.some((q) => q.text === text)) return { __response: fail("已经有一条完全相同的文案了", 409) };
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      const insertAt = lines.length && lines[lines.length - 1].trim() === "" ? lines.length - 1 : lines.length;
      lines.splice(insertAt, 0, line);
      return { hidden: !!body.hidden };
    });
  },

  /** 修改某条（正文 / 标签） */
  "/api/admin/quotes-edit": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.id);
    const text = String(body.text || "").trim();
    if (!Number.isInteger(id) || id < 1) return fail("id 无效", 400);
    if (text.length < 2 || text.length > 1000) return fail("文案长度需要在 2~1000 字之间", 400);
    const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(/[\s,，]+/).filter(Boolean);
    return ghMutate(env, "chore(quotes): 修改 #" + id, (lines, items) => {
      const item = items.find((q) => q.id === id);
      if (!item) return { __response: fail("找不到编号 #" + id, 404) };
      lines[item.line] = formatLine(text, tags, item.hidden);
      return { id };
    });
  },

  /** 下线（可恢复，等于软删除） */
  "/api/admin/quotes-hide": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.id);
    return ghMutate(env, "chore(quotes): 下线 #" + id, (lines, items) => {
      const item = items.find((q) => q.id === id);
      if (!item) return { __response: fail("找不到编号 #" + id, 404) };
      if (item.hidden) return { __response: fail("#" + id + " 已经是下线状态", 400) };
      lines[item.line] = hiddenMark(lines[item.line]);
      return { id };
    });
  },

  /** 恢复下线 */
  "/api/admin/quotes-restore": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.id);
    return ghMutate(env, "chore(quotes): 恢复 #" + id, (lines, items) => {
      const item = items.find((q) => q.id === id);
      if (!item) return { __response: fail("找不到编号 #" + id, 404) };
      if (!item.hidden) return { __response: fail("#" + id + " 本来就是上线状态", 400) };
      lines[item.line] = lines[item.line].replace(/^\s*!\s*/, "");
      return { id };
    });
  },

  /** 批量下线 / 恢复（一次 commit） */
  "/api/admin/quotes-batch": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    let body = {};
    try { body = await request.json(); } catch {}
    const action = String(body.action || "");
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!["hide", "restore"].includes(action)) return fail("action 只能是 hide 或 restore", 400);
    if (!ids.length) return fail("没有选中任何文案", 400);
    if (ids.length > 100) return fail("一次最多操作 100 条", 400);
    return ghMutate(env, "chore(quotes): 批量" + (action === "hide" ? "下线" : "恢复") + " " + ids.length + " 条", (lines, items) => {
      const set = new Set(ids);
      let n = 0;
      for (const item of items) {
        if (!set.has(item.id)) continue;
        if (action === "hide" && !item.hidden) { lines[item.line] = hiddenMark(lines[item.line]); n++; }
        if (action === "restore" && item.hidden) { lines[item.line] = lines[item.line].replace(/^\s*!\s*/, ""); n++; }
      }
      if (!n) return { __response: fail("选中的文案状态没有变化", 400) };
      return { n };
    });
  },

  /* -------------------------------- 草稿箱 -------------------------------- */
  "/api/admin/drafts": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    const drafts = await readDrafts(env);
    if (drafts === null) return fail("未绑定 KV，草稿箱不可用", 503);
    return json({ ok: true, count: drafts.length, rows: drafts }, { headers: { "cache-control": "no-store" } });
  },

  /** 新建 / 更新草稿 */
  "/api/admin/drafts-save": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    let body = {};
    try { body = await request.json(); } catch {}
    const text = String(body.text || "").trim();
    if (text.length < 2 || text.length > 1000) return fail("文案长度需要在 2~1000 字之间", 400);
    const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(/[\s,，]+/).filter(Boolean);
    const drafts = await readDrafts(env);
    if (drafts === null) return fail("未绑定 KV，草稿箱不可用", 503);
    const now = new Date().toISOString();
    const id = body.id ? String(body.id) : "";
    if (id) {
      const idx = drafts.findIndex((d) => d.id === id);
      if (idx < 0) return fail("草稿不存在", 404);
      drafts[idx] = { ...drafts[idx], text, tags, updatedAt: now };
      await writeDrafts(env, drafts);
      return json({ ok: true, id, draft: drafts[idx] }, { headers: { "cache-control": "no-store" } });
    }
    const draft = { id: nextDraftId(drafts), text, tags, createdAt: now, updatedAt: now };
    drafts.unshift(draft);
    await writeDrafts(env, drafts);
    return json({ ok: true, id: draft.id, draft }, { headers: { "cache-control": "no-store" } });
  },

  "/api/admin/drafts-delete": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    let body = {};
    try { body = await request.json(); } catch {}
    const id = String(body.id || "");
    const drafts = await readDrafts(env);
    if (drafts === null) return fail("未绑定 KV，草稿箱不可用", 503);
    const next = drafts.filter((d) => d.id !== id);
    if (next.length === drafts.length) return fail("草稿不存在", 404);
    await writeDrafts(env, next);
    return json({ ok: true, id, remaining: next.length }, { headers: { "cache-control": "no-store" } });
  },

  /** 把草稿发布成正式文案（写进 GitHub，成功后从草稿箱删除） */
  "/api/admin/drafts-publish": async (url, request, env) => {
    const blocked = requireAdmin(request, env);
    if (blocked) return blocked;
    if (!(await isAuthed(request, env))) return fail("未登录或会话已过期", 401);
    let body = {};
    try { body = await request.json(); } catch {}
    const drafts = await readDrafts(env);
    if (drafts === null) return fail("未绑定 KV，草稿箱不可用", 503);
    const all = body.all === true;
    const id = String(body.id || "");
    const picked = all ? drafts.slice() : drafts.filter((d) => d.id === id);
    if (!picked.length) return fail("没有要发布的草稿", 400);
    const linesToAdd = picked.map((d) => formatLine(d.text, d.tags || []));
    const res = await ghMutate(env, "chore(quotes): 发布 " + picked.length + " 条草稿", (lines, items) => {
      const exists = new Set(items.map((q) => q.text));
      const fresh = linesToAdd.filter((l) => {
        const t = l.replace(/^!/, "").replace(/\s+#[^#]*$/, "").trim();
        return !exists.has(t);
      });
      if (!fresh.length) return { __response: fail("这些草稿在文件里都已经存在了", 409) };
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      const at = lines.length && lines[lines.length - 1].trim() === "" ? lines.length - 1 : lines.length;
      lines.splice(at, 0, ...fresh);
      return { n: fresh.length };
    });
    // 提交成功才清掉草稿
    if (res.status === 200) {
      const ids = new Set(picked.map((d) => d.id));
      await writeDrafts(env, (await readDrafts(env)).filter((d) => !ids.has(d.id)));
    }
    return res;
  },
};

/* -------------------------------- 入口 -------------------------------- */

async function handleApi(request, url, env) {
  let pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/api") pathname = "/api/random";
  const route = ROUTES[pathname] || ROUTES[pathname.replace(/\.json$/, "")];
  if (!route) {
    return json({ ok: false, error: "unknown endpoint", endpoints: Object.keys(ROUTES) }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const isPost = request.method === "POST";
  const postAllowed = pathname.startsWith("/api/react") || pathname.startsWith("/api/admin/");
  if (isPost && !postAllowed) return fail("method not allowed", 405);
  if (!isPost && request.method !== "GET" && request.method !== "HEAD") return fail("method not allowed", 405);
  try {
    return await route(url, request, env);
  } catch (err) {
    return json({ ok: false, error: "internal error", detail: String(err && err.message || err) }, { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(request, url, env);

    if (env && env.ASSETS) {
      // /admin 直接给后台页面（静态资源目录索引）
      if (url.pathname === "/admin") {
        const adminRes = await env.ASSETS.fetch(new Request(new URL("/admin/index.html", url), request));
        if (adminRes.status !== 404) return adminRes;
      }
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      // 未知路径回落到首页（保持 SPA 体验）
      const index = await env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
      return new Response(index.body, { status: 200, headers: index.headers });
    }
    return text("不知道你要啥，试试 /api/random\n", { status: 404 });
  },

  /** 每周四 09:00（北京时间 01:00 UTC）推一条文案到自定义 Webhook（可选功能） */
  async scheduled(event, env, ctx) {
    const url = env && env.WEBHOOK_URL;
    if (!url) return; // 没配置就静默跳过
    const q = pickBySeed(QUOTES, "daily:" + beijingDate());
    const kind = (env.WEBHOOK_TYPE || "json").toLowerCase();
    let body;
    if (kind === "serverchan") body = { title: "🍗 疯狂星期四文案", desp: q.text };
    else if (kind === "wecom") body = { msgtype: "text", text: { content: "🍗 疯狂星期四：\n" + q.text + "\n\n" + url } };
    else if (kind === "bark") body = { title: "🍗 疯狂星期四", body: truncate(q.text, 200) };
    else body = { ok: true, id: q.id, text: q.text, tags: q.tags, date: beijingDate() };
    ctx.waitUntil(
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {})
    );
  },
};
