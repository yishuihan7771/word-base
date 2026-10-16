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
    id, value: "", textContent: "", innerHTML: "", hidden: false, dataset: {}, files: [], style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, focus() { focusCalls++; }, click() {},
    closest: () => null, matches: () => false, querySelectorAll: () => [],
  };
}

let fileText = wordsText;
let fsCalls = 0;          // documentElement.requestFullscreen 调用次数
let promptCalls = 0;      // 安装框 prompt() 调用次数
let swCalls = 0;          // serviceWorker.register 调用次数
let chimeCalls = 0;       // 计时到点的提示音（振荡器）次数
let vibrateCalls = 0;     // 振动次数
function boot({ protocol = "http:", failFetch = false, persist = new Map(), touch = false,
                standalone = false, noFullscreen = false, ios = false, swThrows = false,
                startAt = 1750000000000 } = {}) {
  const els = new Map();
  const store = persist;
  const handlers = {};   // window 上的事件处理器，测试里手动触发
  let fetchCalls = 0;
  // 可控时钟：计时一律按时间戳算，测试里靠推进它来模拟真实流逝
  const clock = { now: startAt, advance(ms) { this.now += ms; return this.now; } };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const documentElement = noFullscreen ? {} : {
    requestFullscreen() { fsCalls++; return Promise.resolve(); },
  };
  const document = {
    documentElement,
    body: makeEl("body"),
    fullscreenElement: null,
    activeElement: null,
    exitFullscreen() { return Promise.resolve(); },
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector: () => makeEl("sel"), querySelectorAll: () => [], addEventListener() {}, createElement: () => makeEl(),
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date: FakeDate, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    confirm: () => true,
    location: { protocol, href: protocol === "file:" ? "file:///index.html" : "http://127.0.0.1/" },
    window: {
      scrollTo() {},
      navigator: {
        standalone,
        userAgent: ios ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" : "Mozilla/5.0 (Linux; Android 14) Chrome/125",
        vibrate() { vibrateCalls++; return true; },
        serviceWorker: {
          register: () => {
            swCalls++;
            return swThrows ? Promise.reject(new Error("nope")) : Promise.resolve({ scope: "x" });
          },
        },
      },
      AudioContext: class {
        constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
        resume() {}
        createOscillator() { chimeCalls++; return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
      },
      matchMedia: (q) => ({
        matches: (/pointer:\s*fine/.test(q) && !touch) || (/display-mode/.test(q) && standalone),
      }),
      addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    },
    document,
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
  const text = (id) => els.get(id)?.textContent ?? "";
  return { context, els, store, handlers, fire, clock, text,
           fetchCalls: () => fetchCalls, html: (id) => els.get(id)?.innerHTML ?? "" };
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
  // 按钮不等安装事件就要出现：某些浏览器永远不发这个事件，按钮藏起来就变成「点了没反应」
  check("未安装时按钮即可见", android.els.get("btn-install").hidden, false);

  let prevented = false;
  android.fire("beforeinstallprompt", {
    preventDefault() { prevented = true; },
    prompt() { promptCalls++; return Promise.resolve(); },
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  check("捕获安装事件时阻止浏览器自动弹框", prevented, true);
  check("拿到安装事件后按钮仍可见", android.els.get("btn-install").hidden, false);

  android.context.startInstall();
  check("点按钮会唤起安装框一次", promptCalls, 1);
  await new Promise((r) => setTimeout(r, 0));
  check("接受安装后提示已添加", /已添加/.test(android.els.get("toast").textContent), true);

  // 没有安装事件（多数国产浏览器 / 微信内打开）：按钮仍要给出可操作的指路
  const noEvent = boot({ protocol: "http:", failFetch: true });
  noEvent.context.startInstall();
  check("没有安装事件时提示改用浏览器菜单", /添加到主屏幕/.test(noEvent.els.get("toast").textContent), true);

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

  // 数据页要能读到自检信息，装不上时便于排查
  const diag = boot({ protocol: "http:", failFetch: true });
  diag.context.renderMeta(false);
  check("状态里显示安装情况", /安装状态/.test(diag.html("db-status")), true);
  check("状态里显示 service worker 情况", /service worker/.test(diag.html("db-status")), true);

  // service worker：http 下注册一次；注册失败不影响页面；file:// 下不注册
  swCalls = 0;
  const swOk = boot({ protocol: "http:", failFetch: true });
  await new Promise((r) => setTimeout(r, 0));
  check("http 下注册 service worker", swCalls, 1);
  check("注册后页面照常可用", swOk.els.get("ver").textContent.startsWith("词库"), true);
  check("注册成功后状态显示已注册", /已注册/.test(swOk.html("db-status")), true);

  swCalls = 0;
  const swFail = boot({ protocol: "http:", failFetch: true, swThrows: true });
  await new Promise((r) => setTimeout(r, 0));
  check("service worker 注册失败也不中断脚本", swCalls, 1);
  check("注册失败时状态如实显示", /注册失败/.test(swFail.html("db-status")), true);

  swCalls = 0;
  boot({ protocol: "file:", failFetch: true });
  check("file:// 下不注册 service worker", swCalls, 0);
}

// ---------------------------------------------------------------- 做题计时
{
  // 模式一：区间计时。20 题 / 20 分钟 → 每题 60 秒，题号按已过时间推算
  const a = boot({ protocol: "http:", failFetch: true });
  a.els.get("tm-n").value = "20";
  a.els.get("tm-minutes").value = "20";
  a.context.renderTimer();
  check("区间模式显示平均每题秒数", /平均每题 60 秒/.test(a.text("tm-avg-hint")), true);
  check("未开始时浮条是隐藏的", a.els.get("timer-bar").hidden, true);

  a.context.tmStart();
  check("开始后浮条出现", a.els.get("timer-bar").hidden, false);
  check("开始后大字显示第 1 题", a.text("tm-big"), "第 1 题");
  check("开始后状态是计时中", /计时中/.test(a.text("tm-phase")), true);

  a.clock.advance(90000);          // 过了 90 秒 → 应该在第二题（60 秒一题）
  a.context.tmTick();
  a.context.renderTimer();
  check("90 秒后应该在第 2 题", a.text("tm-big"), "第 2 题");
  check("按时间应完成 1 题", a.text("tm-done"), "按时间应完成 1 题");
  check("浮条同步显示应在第几题", a.text("tb-pos"), "应在第 2/20 题");
  check("浮条倒计时是总时间剩余", a.text("tb-clock"), "18:30");

  a.clock.advance(1110000);        // 累加到 20 分钟整
  a.context.tmTick();
  check("到总时间自动结束", /已结束/.test(a.text("tm-phase")), true);
  check("结束后浮条隐藏", a.els.get("timer-bar").hidden, true);
  check("结果写明计划与用时", /计划 20 题 \/ 20 分钟/.test(a.text("tm-result")), true);
  check("结束后记录了本轮历史", JSON.parse(a.store.get("kg.timer.v1")).history.length, 1);
  check("区间模式不显示「下一题」", a.els.get("tb-next").hidden, true);

  // 模式二：分题计时。3 题 / 每题 30 秒，时间到要响声音提示并等用户点下一题
  chimeCalls = 0;
  vibrateCalls = 0;
  const p = boot({ protocol: "http:", failFetch: true });
  p.context.tmSetMode("perq");
  p.els.get("tm-n").value = "3";
  p.els.get("tm-perq").value = "30";
  p.context.tmStart();
  p.context.renderTimer();
  check("分题模式大字显示题号", p.text("tm-big"), "第 1 题");
  check("分题模式不显示总时间输入", p.els.get("tm-range-only").hidden, true);

  p.clock.advance(30000);
  p.context.tmTick();
  p.context.renderTimer();
  check("时间到大字变成「时间到」", p.text("tm-big"), "时间到");
  check("时间到会响提示音（3 声）", chimeCalls, 3);
  check("时间到同时振动", vibrateCalls, 1);
  check("时间到后状态是等下一题", /等下一题/.test(p.text("tm-phase")), true);
  check("时间到后「下一题」按钮可用", p.els.get("tm-next").disabled, false);
  check("浮条也提示该换题了", /该换题了/.test(p.text("tb-pos")), true);

  p.context.tmNextQuestion();
  p.context.renderTimer();
  check("点下一题进入第 2 题", p.text("tm-big"), "第 2 题");
  check("超时被计入", p.text("tm-timeout"), "超时 1 题");

  p.clock.advance(10000);          // 第 2 题提前 20 秒做完
  p.context.tmNextQuestion();
  p.context.renderTimer();
  check("提前做完也能进入下一题", p.text("tm-big"), "第 3 题");

  p.clock.advance(30000);
  p.context.tmTick();
  p.context.tmNextQuestion();
  check("做完最后一题自动结束", /已结束/.test(p.text("tm-phase")), true);
  check("结果统计共 3 题", /共 3 \/ 3 题/.test(p.text("tm-result")), true);
  check("结果里有平均每题", /平均每题/.test(p.text("tm-result")), true);
  check("分题模式记录超时数", /超时 2 题/.test(p.text("tm-result")), true);

  // 暂停：暂停期间不该继续消耗时间
  const q2 = boot({ protocol: "http:", failFetch: true });
  q2.context.tmSetMode("perq");
  q2.els.get("tm-n").value = "3";
  q2.els.get("tm-perq").value = "30";
  q2.context.tmStart();
  q2.clock.advance(10000);
  q2.context.tmPauseToggle();
  check("暂停后状态是已暂停", /已暂停/.test(q2.text("tm-phase")), true);
  q2.clock.advance(120000);        // 暂停两分钟
  q2.context.tmPauseToggle();
  q2.clock.advance(5000);          // 恢复后再走 5 秒，共 15 秒，不该到点
  q2.context.tmTick();
  q2.context.renderTimer();
  check("暂停的时间不计入本题", /第 1 题/.test(q2.text("tm-big")), true);
  check("恢复后计时继续（未误判超时）", /计时中/.test(q2.text("tm-phase")), true);

  // 设置会存到本机，下次打开还在
  const keep = JSON.parse(q2.store.get("kg.timer.v1"));
  check("设置写入本机", [keep.mode, keep.n, keep.perq], ["perq", 3, 30]);
  const again = boot({ protocol: "http:", failFetch: true, persist: q2.store });
  check("重开页面沿用上次设置", [again.text("tm-phase"), again.els.get("tm-n").value], ["未开始", 3]);

  // 计时中不让切模式，避免把一轮的统计搞乱
  q2.context.tmSetMode("range");
  check("计时中切换模式会被拦住", /先结束本轮/.test(q2.text("toast")), true);
}

// ---------------------------------------------------------------- 计时：模式按钮与三个数字联动
{
  // 模式按钮要有明确的选中状态（data-on），并且切换时跟着变
  const m = boot({ protocol: "http:", failFetch: true });
  check("默认是模式一且按钮标为选中", [m.els.get("tm-mode-range").dataset.on, m.els.get("tm-mode-perq").dataset.on], ["true", "false"]);
  m.context.tmSetMode("perq");
  check("切到模式二后选中状态跟着变", [m.els.get("tm-mode-range").dataset.on, m.els.get("tm-mode-perq").dataset.on], ["false", "true"]);
  check("切到模式二后提示文案也变了", /只填题量和每题间隔/.test(m.text("tm-mode-hint")), true);
  check("模式二下总时间输入框隐藏", m.els.get("tm-range-only").hidden, true);
  check("模式二下显示算出来的总时间", m.els.get("tm-total-hint").hidden, false);
  m.context.tmSetMode("range");
  check("切回模式一后总时间输入框恢复", m.els.get("tm-range-only").hidden, false);
  check("模式一下不显示总时间结果", m.els.get("tm-total-hint").hidden, true);

  // 区间模式：改总时间 → 每题跟着变
  const g = boot({ protocol: "http:", failFetch: true });
  g.els.get("tm-n").value = "20";
  g.els.get("tm-minutes").value = "20";
  g.context.tmSyncFromInputs("minutes");
  check("20 题 / 20 分钟 → 每题 60 秒", g.els.get("tm-perq").value, "60");
  g.els.get("tm-minutes").value = "10";
  g.context.tmSyncFromInputs("minutes");
  check("总时间改成 10 分钟 → 每题变 30 秒", g.els.get("tm-perq").value, "30");

  // 区间模式：改每题 → 总时间跟着变
  g.els.get("tm-perq").value = "45";
  g.context.tmSyncFromInputs("perq");
  check("每题改成 45 秒 → 总时间变 15 分钟", g.els.get("tm-minutes").value, "15");

  // 区间模式：改题量 → 每题跟着变（以总时间为锚）
  g.els.get("tm-n").value = "10";
  g.context.tmSyncFromInputs("n");
  check("题量改成 10 → 每题变 90 秒", g.els.get("tm-perq").value, "90");
  check("题量改成 10 时总时间不动", g.els.get("tm-minutes").value, "15");

  // 正在输入的那个框不能被回填冲掉（否则「先清空再输入」会被打断）
  g.els.get("tm-minutes").value = "";
  g.context.tmSyncFromInputs("minutes");
  check("清空总时间框时不会把值硬塞回去", g.els.get("tm-minutes").value, "");
  g.els.get("tm-minutes").value = "12";
  g.context.tmSyncFromInputs("minutes");
  check("继续输入后每题重新算", g.els.get("tm-perq").value, "72");

  // 分题模式：只输入题量和每题，总时间算出来；改题量不该改每题
  const s = boot({ protocol: "http:", failFetch: true });
  s.context.tmSetMode("perq");
  s.els.get("tm-n").value = "20";
  s.els.get("tm-perq").value = "30";
  s.context.tmSyncFromInputs("perq");
  check("分题模式显示总时间", s.text("tm-total-text"), "10:00（20 题 × 30 秒）");
  s.els.get("tm-n").value = "40";
  s.context.tmSyncFromInputs("n");
  check("分题模式改题量不会改每题", s.els.get("tm-perq").value, "30");
  check("分题模式改题量后总时间跟着变", s.text("tm-total-text"), "20:00（40 题 × 30 秒）");

  // 每 200ms 的重绘不能覆盖输入框
  s.els.get("tm-perq").value = "35";
  s.context.renderTimer();
  check("重绘不会给输入框回填旧值", s.els.get("tm-perq").value, "35");
}

// ---------------------------------------------------------------- 区间模式每推进一题响一声
{
  chimeCalls = 0;
  vibrateCalls = 0;
  const v = boot({ protocol: "http:", failFetch: true });
  v.els.get("tm-n").value = "20";
  v.els.get("tm-minutes").value = "20";   // 每题 60 秒
  v.context.tmStart();
  check("开始时不响（还在第 1 题）", chimeCalls, 0);

  v.clock.advance(59000);                 // 还差 1 秒到第 2 题
  v.context.tmTick();
  check("没到点不响", chimeCalls, 0);

  v.clock.advance(2000);                  // 跨过 60 秒 → 推进到第 2 题
  v.context.tmTick();
  check("推进一题响两声（比「时间到」的三声轻）", chimeCalls, 2);
  check("推进一题也振动一次", vibrateCalls, 1);
  check("提示写明该做第几题", /该做第 2 题了/.test(v.text("toast")), true);

  v.context.tmTick();                     // 同一题的 200ms 内重复 tick
  check("同一题不会重复响", chimeCalls, 2);

  v.clock.advance(60000);                 // 再推进一题
  v.context.tmTick();
  check("推进第 3 题再响两声", chimeCalls, 4);

  // 手机锁屏/切后台回来时可能一下落下好几题：只响一声，并说明落下几题
  chimeCalls = 0;
  v.clock.advance(300000);                // 一下过去 5 分钟（5 题）
  v.context.tmTick();
  check("一次落下多题也只响一声", chimeCalls, 2);
  check("落下多题时提示说明", /中间落下 4 题/.test(v.text("toast")), true);

  // 关掉开关就不再响
  chimeCalls = 0;
  v.context.tmSetChime(false);
  v.clock.advance(60000);
  v.context.tmTick();
  check("关掉开关后不再响", chimeCalls, 0);

  // 重新打开后继续响
  v.context.tmSetChime(true);
  v.clock.advance(60000);
  v.context.tmTick();
  check("重新打开后继续响", chimeCalls, 2);
  check("开关状态存本机", JSON.parse(v.store.get("kg.timer.v1")).chimePerQ, true);

  // 分题模式不该用它：那边的提示音走「时间到」三声
  chimeCalls = 0;
  const w = boot({ protocol: "http:", failFetch: true });
  w.context.tmSetMode("perq");
  w.els.get("tm-n").value = "3";
  w.els.get("tm-perq").value = "30";
  w.context.tmStart();
  w.clock.advance(30000);
  w.context.tmTick();
  check("分题模式到点是三声长鸣", chimeCalls, 3);
}

console.log(`\n${failures ? failures + " FAILURE(S)" : "all checks passed"}`);
process.exit(failures ? 1 : 0);
