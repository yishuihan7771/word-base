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
let fsCalls = 0;          // documentElement.requestFullscreen 调用次数
let promptCalls = 0;      // 安装框 prompt() 调用次数
let swCalls = 0;          // serviceWorker.register 调用次数
function boot({ protocol = "http:", failFetch = false, persist = new Map(), touch = false,
                standalone = false, noFullscreen = false, ios = false, swThrows = false } = {}) {
  const els = new Map();
  const store = persist;
  const handlers = {};   // window 上的事件处理器，测试里手动触发
  let fetchCalls = 0;
  const documentElement = noFullscreen ? {} : {
    requestFullscreen() { fsCalls++; return Promise.resolve(); },
  };
  const context = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    confirm: () => true,
    location: { protocol, href: protocol === "file:" ? "file:///index.html" : "http://127.0.0.1/" },
    window: {
      scrollTo() {},
      navigator: {
        standalone,
        userAgent: ios ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" : "Mozilla/5.0 (Linux; Android 14) Chrome/125",
        serviceWorker: {
          register: () => {
            swCalls++;
            return swThrows ? Promise.reject(new Error("nope")) : Promise.resolve({ scope: "x" });
          },
        },
      },
      matchMedia: (q) => ({
        matches: (/pointer:\s*fine/.test(q) && !touch) || (/display-mode/.test(q) && standalone),
      }),
      addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    },
    document: {
      documentElement,
      fullscreenElement: null,
      exitFullscreen() { return Promise.resolve(); },
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
  const fire = (type, event) => { for (const fn of handlers[type] || []) fn(event); };
  return { context, els, store, handlers, fire, fetchCalls: () => fetchCalls, html: (id) => els.get(id)?.innerHTML ?? "" };
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

// ---------------------------------------------------------------- 全屏与防误触
{
  fsCalls = 0;
  const b = boot({ protocol: "http:" });
  b.context.toggleFullscreen();
  // 同步断言：启动时的 checkUpdate 是异步的，等一拍会被它的「词库已载入」提示覆盖
  check("支持全屏时点按钮会请求全屏", fsCalls, 1);
  check("全屏按钮显示为「全屏」", b.els.get("btn-fullscreen").textContent, "全屏");
  check("非全屏状态下按钮可见", b.els.get("btn-fullscreen").hidden, false);

  // 模拟已经进入全屏：按钮要变成「退出全屏」
  b.context.document.fullscreenElement = b.context.document.documentElement;
  b.context.syncFullscreenButton();
  check("全屏后按钮变「退出全屏」", b.els.get("btn-fullscreen").textContent, "退出全屏");

  // 已装成主屏幕应用：不该再显示全屏按钮
  const standalone = boot({ protocol: "http:", standalone: true });
  check("从主屏幕打开时不显示全屏按钮", standalone.els.get("btn-fullscreen").hidden, true);

  // 浏览器不支持全屏（iOS Safari）：隐藏按钮，点了给提示
  const unsupported = boot({ protocol: "http:", noFullscreen: true });
  check("不支持全屏时隐藏按钮", unsupported.els.get("btn-fullscreen").hidden, true);
  unsupported.context.toggleFullscreen();
  check("不支持全屏时给出「添加到主屏幕」提示", /添加到主屏幕/.test(unsupported.els.get("toast").textContent), true);
}

// ---------------------------------------------------------------- 一键添加到桌面
{
  // 用 failFetch 起，避免启动时的「词库已载入」提示覆盖掉安装提示（那是异步的）
  promptCalls = 0;
  const android = boot({ protocol: "http:", failFetch: true });
  check("没拿到安装事件前按钮是隐藏的", android.els.get("btn-install").hidden, true);

  let prevented = false;
  android.fire("beforeinstallprompt", {
    preventDefault() { prevented = true; },
    prompt() { promptCalls++; return Promise.resolve(); },
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  check("捕获安装事件时阻止浏览器自动弹框", prevented, true);
  check("拿到安装事件后按钮出现", android.els.get("btn-install").hidden, false);

  android.context.startInstall();
  check("点按钮会唤起安装框一次", promptCalls, 1);
  await new Promise((r) => setTimeout(r, 0));
  check("接受安装后提示已添加", /已添加/.test(android.els.get("toast").textContent), true);

  // 用户在系统框里取消：记下来，不再反复打扰
  const declineStore = new Map();
  const decline = boot({ protocol: "http:", failFetch: true, persist: declineStore });
  decline.fire("beforeinstallprompt", {
    preventDefault() {},
    prompt: () => Promise.resolve(),
    userChoice: Promise.resolve({ outcome: "dismissed" }),
  });
  decline.context.startInstall();
  await new Promise((r) => setTimeout(r, 0));
  check("取消后记入本机", declineStore.get("kg.install.v1"), "dismissed");
  decline.context.syncInstallButton();
  check("取消后按钮不再显示", decline.els.get("btn-install").hidden, true);

  // iOS Safari：没有安装接口，按钮仍要出现并给指路提示
  const iphone = boot({ protocol: "http:", failFetch: true, ios: true });
  check("iPhone 上按钮可见", iphone.els.get("btn-install").hidden, false);
  iphone.context.startInstall();
  check("iPhone 提示走分享菜单", /分享/.test(iphone.els.get("toast").textContent), true);

  // 已经是桌面应用：不必再提示安装
  const installed = boot({ protocol: "http:", failFetch: true, standalone: true });
  check("已装成桌面应用时隐藏安装按钮", installed.els.get("btn-install").hidden, true);

  // 其他浏览器既不支持也不给事件：按钮隐藏，点了有兜底提示
  const other = boot({ protocol: "http:", failFetch: true });
  other.context.startInstall();
  check("不支持时提示用浏览器菜单", /浏览器菜单/.test(other.els.get("toast").textContent), true);

  // service worker：http 下注册一次；注册失败不影响页面；file:// 下不注册
  swCalls = 0;
  const swOk = boot({ protocol: "http:", failFetch: true });
  await new Promise((r) => setTimeout(r, 0));
  check("http 下注册 service worker", swCalls, 1);
  check("注册后页面照常可用", swOk.els.get("ver").textContent.startsWith("词库"), true);

  swCalls = 0;
  const swFail = boot({ protocol: "http:", failFetch: true, swThrows: true });
  await new Promise((r) => setTimeout(r, 0));
  check("service worker 注册失败也不中断脚本", swCalls, 1);

  swCalls = 0;
  boot({ protocol: "file:", failFetch: true });
  check("file:// 下不注册 service worker", swCalls, 0);
}

console.log(`\n${failures ? failures + " FAILURE(S)" : "all checks passed"}`);
process.exit(failures ? 1 : 0);
