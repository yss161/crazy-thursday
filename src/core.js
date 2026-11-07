// 纯逻辑：解析文案文件、随机/每日/搜索/洗牌。不依赖 Workers 运行时，方便在 Node 里单测。

function normalize(line) {
  return line.replace(/^\uFEFF/, "").replace(/\r/g, "").replace(/[\t ]+/g, " ").trim();
}

/**
 * 解析 quotes.txt（底层版，带行号 / 下线状态，供后台精确回写文件用）
 * 规则：
 *   - 一行一条；空行、# 注释忽略
 *   - "!" 开头 = 已下线（可恢复），仍然占用 id 槽位，因此下线/恢复不会影响其它文案的编号
 *   - 行尾 {空格}#标签 视为标签
 *   - 完全重复的正文只保留第一次出现的那一条
 * @returns {{id:number,text:string,tags:string[],hidden:boolean,line:number}[]}
 */
export function parseAll(raw) {
  const out = [];
  const seen = new Set();
  const lines = String(raw).split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = normalize(lines[i]);
    if (!line || line.startsWith("#")) continue;
    let hidden = false;
    if (line.startsWith("!")) {
      hidden = true;
      line = line.slice(1).trim();
      if (!line) continue;
    }
    const tags = [];
    const collected = [];
    let m;
    while ((m = line.match(/\s+#([^\s#]{1,20})$/u))) {
      collected.unshift(m[1]);
      line = line.slice(0, m.index);
    }
    const text = line.trim();
    if (text.length < 2) continue;
    for (const t of collected) if (!tags.includes(t)) tags.push(t);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ id: out.length + 1, text, tags, hidden, line: i });
  }
  return out;
}

/** 只返回上架的文案（前台 / API 用） */
export function parseQuotes(raw) {
  return parseAll(raw)
    .filter((q) => !q.hidden)
    .map((q) => ({ id: q.id, text: q.text, tags: q.tags }));
}

/** 把一条文案序列化成 quotes.txt 里的一行（保持 #标签 语法） */
export function formatLine(text, tags = [], hidden = false) {
  const clean = String(text)
    .replace(/\r/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+#/g, " ＃")
    .trim();
  const tagStr = (tags || [])
    .map((t) => String(t).replace(/[\s#]/g, "").slice(0, 20))
    .filter(Boolean)
    .join(" #");
  return (hidden ? "!" : "") + clean + (tagStr ? " #" + tagStr : "");
}

/** 32 位字符串哈希（FNV-1a） */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 北京时间（UTC+8）的 YYYY-MM-DD */
export function beijingDate(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 该日期是不是星期四 */
export function isThursday(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCDay() === 4;
}

/** 距离下一个星期四还有几天（0=今天） */
export function daysUntilThursday(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return (4 - d + 7) % 7;
}

/** 按种子确定性选取 */
export function pickBySeed(list, seed) {
  if (!list.length) return null;
  return list[hash32(String(seed)) % list.length];
}

/** 随机选取 */
export function pickRandom(list, rnd = Math.random) {
  if (!list.length) return null;
  return list[Math.floor(rnd() * list.length) % list.length];
}

/** 随机不重复的 n 条 */
export function pickMany(list, n, rnd = Math.random) {
  const pool = list.slice();
  const out = [];
  const k = Math.max(0, Math.min(n, pool.length));
  for (let i = 0; i < k; i++) {
    const j = Math.floor(rnd() * pool.length) % pool.length;
    out.push(pool.splice(j, 1)[0]);
  }
  return out;
}

/** Fisher-Yates 洗牌（返回新数组） */
export function shuffle(list, rnd = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1)) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 按标签过滤（不区分大小写）；tag 为空返回原列表，无命中时也返回原列表 */
export function filterByTag(list, tag) {
  if (!tag) return list;
  const t = String(tag).toLowerCase();
  const hit = list.filter((q) => q.tags.some((x) => x.toLowerCase() === t));
  return hit.length ? hit : list;
}

/** 关键词搜索（空格分词，全部命中才算） */
export function searchQuotes(list, q) {
  const terms = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return list;
  return list.filter((item) => {
    const hay = (item.text + " " + item.tags.join(" ")).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** 标签统计 */
export function tagIndex(list) {
  const counts = {};
  for (const q of list) for (const t of q.tags) counts[t] = (counts[t] || 0) + 1;
  return counts;
}

/** 截断到指定长度（用于分享卡片/摘要） */
export function truncate(text, max = 120) {
  const s = String(text);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
