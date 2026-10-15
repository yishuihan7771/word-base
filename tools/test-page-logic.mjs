// index.html 的行为测试：桩化 DOM，在 Node 里把页面跑起来验真实逻辑。
// 覆盖：词库载入、搜索（首字母/拼音）、已删除功能不再存在、清除本机数据、
//       切页是否弹输入法、手动补充说明。
//
// 用法（在仓库任意位置都能跑）：
//     node tools/test-page-logic.mjs
//
// 以「all checks passed」结束才算通过。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../", import.meta.url);
const page = readFileSync(new URL("index.html", ROOT), "utf8");
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
const wordsText = readFileSync(new URL("words.json", ROOT), "utf8");
const wordsJson = JSON.parse(wordsText);

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

let focusCalls = 0;
function makeEl(id = "") {
  return {
    id, value: "", textContent: "", innerHTML: "", hidden: false, dataset: {}, files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, focus() { focusCalls++; }, click() {},
    closest: () => null, matches: () => false, querySelectorAll: () => [],
  };
}

let fileText = wordsText;
function boot({ protocol = "http:", failFetch = false, persist = new Map(), touch = false } = {}) {
  const els = new Map();
  const store = persist;
  let fetchCalls = 0;
  const context = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    confirm: () => true,
    location: { protocol, href: protocol === "file:" ? "file:///index.html" : "http://127.0.0.1/" },
    window: {
      scrollTo() {},
      matchMedia: (q) => ({ matches: !touch && /pointer:\s*fine/.test(q) }),
    },
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [], addEventListener() {}, createElement: () => makeEl(),
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async () => {
      fetchCalls++;
      if (failFetch) throw new Error("offline");
      return { ok: true, status: 200, json: async () => wordsJson };
    },
    Blob: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    FileReader: class { readAsText() { this.result = fileText; setTimeout(() => this.onload(), 0); } },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(script, context, { filename: "index.html" });
  return { context, store, fetchCalls: () => fetchCalls, html: (id) => els.get(id)?.innerHTML ?? "" };
}

// ---------------------------------------------------------------- 正常使用
{
  const b = boot({ protocol: "http:" });
  await b.context.checkUpdate(false);
  check("library loads", b.context.allWords().length, wordsJson.words.length);
  check("empty query lists at most 12 recent words", b.context.search("").length <= 12, true);
  check("search by initials", (b.context.search("ycej")[0] || {}).w, "一蹴而就");
  check("search by initials (multi-char abbr)", (b.context.search("ermr")[0] || {}).w, "耳濡目染");
  check("manual-add feature is gone", typeof b.context.importWordList, "undefined");
  check("no local-words state left", b.context.state === undefined || !("local" in (b.context.state || {})), true);

  b.context.openWord("一蹴而就");
  check("query recorded", JSON.parse(b.store.get("kg.stats.v1"))["一蹴而就"].q, 1);
}

// ---------------------------------------------------------------- 清除本机数据（联网）
{
  const persist = new Map();
  const b = boot({ protocol: "http:", persist });
  await b.context.checkUpdate(false);
  b.context.openWord("首当其冲");
  persist.set("kg.local.v1", '[{"w":"老残留"}]'); // 旧版本留下的键
  check("state before clear", [persist.has("kg.db.v1"), persist.has("kg.stats.v1"), persist.has("kg.local.v1")], [true, true, true]);

  await b.context.clearLocalData();
  check("stats wiped", JSON.parse(persist.get("kg.stats.v1") || "{}"), {});
  check("retired key removed", persist.has("kg.local.v1"), false);
  check("library re-fetched after clear", b.context.allWords().length, wordsJson.words.length);
  check("library cache rewritten by the refetch", persist.has("kg.db.v1"), true);
  check("search still works after clear", (b.context.search("ycej")[0] || {}).w, "一蹴而就");
  check("stats start empty after clear", JSON.parse(persist.get("kg.stats.v1") || "{}"), {});
}

// ---------------------------------------------------------------- 清除本机数据（双击打开，无网络）
{
  const persist = new Map();
  const b = boot({ protocol: "file:", failFetch: true, persist });
  b.context.readFile({});
  await new Promise((r) => setTimeout(r, 5));
  check("library imported from file", b.context.allWords().length, wordsJson.words.length);
  await b.context.clearLocalData();
  check("clear wipes the library in file:// mode", b.context.allWords().length, 0);
  b.context.renderResults();
  check("empty state offers the import button again", /data-import/.test(b.html("results")), true);
}

// ---------------------------------------------------------------- 导入非词库文件不应崩
{
  const b = boot({ protocol: "file:", failFetch: true });
  fileText = '{"hello":"world"}';
  b.context.readFile({});
  await new Promise((r) => setTimeout(r, 5));
  check("non-library json is rejected", b.context.allWords().length, 0);
  fileText = wordsText;
}

// ---------------------------------------------------------------- 切页时是否弹键盘
{
  focusCalls = 0;
  const touch = boot({ protocol: "http:", touch: true });
  touch.context.switchTab("stats");
  touch.context.switchTab("search");
  check("触摸设备切到查询页不自动聚焦（不弹输入法）", focusCalls, 0);

  focusCalls = 0;
  const desktop = boot({ protocol: "http:", touch: false });
  desktop.context.switchTab("stats");
  desktop.context.switchTab("search");
  check("桌面设备切到查询页仍自动聚焦", focusCalls, 1);

  focusCalls = 0;
  const noMatchMedia = boot({ protocol: "http:", touch: true });
  delete noMatchMedia.context.window.matchMedia;
  noMatchMedia.context.switchTab("search");
  check("没有 matchMedia 时保守处理（不聚焦）", focusCalls, 0);
}

// ---------------------------------------------------------------- 手动补充说明
{
  const b = boot({ protocol: "http:" });
  await b.context.checkUpdate(false);
  b.context.openWord("首当其冲");
  check("详情页有「补充说明」入口", /data-edit/.test(b.html("results")), true);

  b.context.saveNote("首当其冲", { tone: "贬", pos: "成语·动词性", modifies: "人、地区、行业", subject: "主语多为“人、地区”", key: "含“受害”义，别当成“首先”", note: "10.15 第 4 题考过" });
  check("补充写入 localStorage", JSON.parse(b.store.get("kg.notes.v1"))["首当其冲"].tone, "贬");

  const html = b.context.detailHtml(wordsJson.words.find((w) => w.w === "首当其冲"));
  check("详情页显示补充的褒贬", /贬/.test(html), true);
  check("详情页显示补充的词性", /成语·动词性/.test(html), true);
  check("详情页显示其他说明", /10\.15 第 4 题考过/.test(html), true);
  check("补充过的字段打标", /补充/.test(html), true);

  b.context.saveNote("首当其冲", { tone: "" });
  check("空值视为删除该条补充", Object.keys(JSON.parse(b.store.get("kg.notes.v1"))).length, 0);

  b.context.saveNote("首当其冲", { tone: "贬" });
  b.context.openWord("首当其冲");
  check("删除补充后详情页回退到词库值", /data-edit/.test(b.html("results")), true);
  b.context.clearNote("首当其冲");
  check("clearNote 清掉该词", JSON.parse(b.store.get("kg.notes.v1"))["首当其冲"], undefined);

  // 导出的备份里要带上补充说明
  b.context.saveNote("一蹴而就", { note: "常考否定句" });
  let exported = null;
  b.context.Blob = class { constructor(parts) { exported = parts[0]; } };
  b.context.URL.createObjectURL = () => "blob:x";
  b.context.exportJson();
  check("导出包含补充说明", JSON.parse(exported).notes["一蹴而就"].note, "常考否定句");

  // 清除本机数据要连补充说明一起清掉
  await b.context.clearLocalData();
  check("清除本机数据也清掉补充说明", b.store.has("kg.notes.v1"), false);
  check("清除后详情页不再显示补充", /常考否定句/.test(b.context.detailHtml(wordsJson.words.find((w) => w.w === "一蹴而就"))), false);
}

console.log(`\n${failures ? failures + " FAILURE(S)" : "all checks passed"}`);
process.exit(failures ? 1 : 0);
