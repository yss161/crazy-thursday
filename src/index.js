import RAW_QUOTES from "../quotes.txt";
import {
  parseQuotes, pickRandom, pickBySeed, pickMany, shuffle,
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
      { headers: { "cache-control": "public, max-age=300" } }
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
