// 零依赖自测：解析规则、随机/每日/搜索/洗牌、数据完整性
import { readFileSync } from "node:fs";
import {
  parseQuotes, pickRandom, pickBySeed, pickMany, shuffle,
  filterByTag, searchQuotes, tagIndex, beijingDate, isThursday,
  daysUntilThursday, hash32, truncate,
} from "../src/core.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

console.log("1) quotes.txt 解析规则");
const sample = parseQuotes(
  "\uFEFF# 注释行\n\n第一条文案\n  第二条文案  \n第一条文案\n求人 V 我 50 #经典 #求人\n!这条被下线了\n!被下线但带标签 #废弃\n"
);
ok(sample.length === 3, "注释/空行/重复/下线行都被过滤，剩 3 条");
ok(sample[0].text === "第一条文案", "纯文本行");
ok(sample[1].text === "第二条文案", "首尾空白被裁剪");
ok(sample[2].text === "求人 V 我 50", "行尾标签被剥离");
ok(sample[2].tags.join(",") === "经典,求人", "多标签解析正确");
ok(sample.every((q, i) => q.id === i + 1), "id 连续从 1 开始（下线行不占号）");

console.log("2) 选取与筛选");
const pool = [{ id: 1, text: "a", tags: ["x"] }, { id: 2, text: "b", tags: ["y"] }, { id: 3, text: "c", tags: ["x"] }];
ok(pickRandom(pool, () => 0).id === 1 && pickRandom(pool, () => 0.99).id === 3, "随机下标边界正确");
ok(pickBySeed(pool, "2026-11-05") === pickBySeed(pool, "2026-11-05"), "同一种子结果稳定");
ok(new Set(["2026-11-05","2026-11-06","2026-11-07","2026-11-12","2026-11-19"].map((d) => pickBySeed(pool, "daily:" + d).id)).size > 1, "不同日期分布不同");
ok(pickMany(pool, 2).length === 2 && new Set(pickMany(pool, 5).map((q) => q.id)).size === 3, "pickMany 不重复且自动截断");
ok(shuffle(pool).length === 3 && pool[0].id === 1, "shuffle 不改原数组");
ok(filterByTag(pool, "x").length === 2, "标签过滤");
ok(filterByTag(pool, "不存在").length === 3, "无命中时退化为全库");
ok(searchQuotes(pool, "").length === 3, "空关键词返回全部");
ok(searchQuotes([{ id: 1, text: "今天吃炸鸡", tags: ["美食"] }], "炸鸡 美食").length === 1, "多关键词 AND 搜索（含标签）");
ok(searchQuotes(pool, "zzz").length === 0, "无命中返回空");
ok(Object.keys(tagIndex(pool)).length === 2, "标签统计");
ok(pickRandom([], () => 0.5) === null, "空列表返回 null");

console.log("3) 日期工具");
ok(/^\d{4}-\d{2}-\d{2}$/.test(beijingDate()), "北京日期格式 YYYY-MM-DD");
ok(isThursday("2026-11-05") === true, "2026-11-05 是星期四");
ok(isThursday("2026-11-06") === false, "2026-11-06 不是星期四");
ok(daysUntilThursday("2026-11-05") === 0 && daysUntilThursday("2026-11-06") === 6, "距离下个星期四天数");
ok(hash32("abc") === hash32("abc") && hash32("abc") !== hash32("abd"), "哈希稳定");
ok(truncate("1234567890", 5) === "1234…", "截断加省略号");

console.log("4) quotes.txt 数据文件");
const raw = readFileSync(new URL("../quotes.txt", import.meta.url), "utf8");
const quotes = parseQuotes(raw);
ok(quotes.length > 400, "文案数量：" + quotes.length + " 条");
ok(quotes.every((q) => q.text.length >= 2 && !q.text.includes("\n")), "每条文案非空且单行");
ok(new Set(quotes.map((q) => q.text)).size === quotes.length, "无重复文案");
ok(quotes.every((q) => !q.text.startsWith("!") && !q.text.startsWith("#")), "控制字符没有漏进正文");
const longest = quotes.reduce((a, b) => (b.text.length > a.text.length ? b : a));
ok(longest.text.length < 1200, "最长文案 " + longest.text.length + " 字符");

console.log(`\n结果：${pass} 通过，${fail} 失败 · 文案 ${quotes.length} 条`);
process.exit(fail ? 1 : 0);
