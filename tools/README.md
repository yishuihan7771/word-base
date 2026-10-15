# tools

网页应用的检查、测试，以及「新做一套题 → 词库自动扩充」的流水线。都是独立脚本，无第三方依赖
（除 Python 的 `lxml`，与本仓库其它脚本一致）。

## 检查与测试

```bash
python tools/check-page.py        # 静态检查：内联脚本语法、词库 schema、HTML 结构与 id 引用、功能是否还在
node   tools/test-page-logic.mjs  # 行为测试：桩化 DOM 把 index.html 跑起来，30 项断言
```

两个都要以「all checks passed」结束。改了 `index.html` 或 `words.json` 之后应当各跑一遍。
`test-page-logic.mjs` 里的用例和词库内容相关（例如 `ycej` → 一蹴而就），换词库后如有失败，
先确认是断言过时还是功能真的坏了。

## 新做一套题，把选项词并进词库

以「粉笔练习页的浏览器存档」为输入（保存网页，或用 `tools/` 之外的方式拿到 `.html`）：

```bash
# 1) 采集选项词：去重、取出解析里给出的释义、记录真题来源
python tools/collect-exam-words.py 练习.html --report out/review.md --json out/collected.json
python tools/collect-exam-words.py 练习.html --merge words.json   # 把库里没有的词并进去

# 2) 补词库缺的释义和拼音（汉典）
python tools/fetch-han-dian.py --dry-run          # 先看会改什么
python tools/fetch-han-dian.py                    # 释义 + 拼音，版本号自动递增

# 3) 验证
python tools/check-page.py && node tools/test-page-logic.mjs
```

采集脚本只认解析里**明确写了释义**的句子（`X项“词”指…`）；只讲怎么排除选项、没有下定义的，
一律留空标「待补释义」，不硬编。汉典拿不到的（多为「丰富性」「随意性」这类非成语）同样留空。

## 图标与全屏

`index.html` 通过 `manifest.json`（`display: fullscreen`）与 `apple-mobile-web-app-capable`
支持装成桌面应用后全屏运行，手机上没有地址栏、不会误点跳走，下拉也不刷新页面。

一键添加桌面靠 `beforeinstallprompt`：安卓 Chrome 会发这个事件，页面抓住它、在点按钮时调
`prompt()` 唤起系统安装框；**iPhone Safari 没有这个事件、也没有任何接口能触发安装**，页面只能提示
走「分享 → 添加到主屏幕」。`sw.js` 是个穿透式 service worker——Chrome 判定「可安装」需要它，
但它不缓存任何内容（`fetch` 处理器不调用 `respondWith`），所以不会读到旧页面。

```bash
python tools/make-icons.py     # 需要 Pillow；改配色/字样后重跑生成三个图标
```

`tools/check-page.py` 会顺带校验：manifest 的 `display` 必须是 `fullscreen`、声明了 `start_url`、
每个图标在磁盘上存在且尺寸与声明一致，以及 `sw.js` 有 fetch 处理器且**没有**任何缓存调用
（用正则只认真实调用，注释里提到的不算）。

## 字段来源

词库每条都带 `src` 标明释义出处，便于复核：

| src | 含义 |
| --- | --- |
| `exam` | 从粉笔解析原文取到 |
| `汉典` | 从汉典取到，另有 `srcUrl` 指回原页 |

词性、褒贬意、用来修饰、主语这几个字段，真题解析与汉典都不提供（解析只为排除选项而写，
汉典页面只有释义），所以大多数条目是空的——需要时在网页详情页的「补充说明」里手写，
那部分存在浏览器本机，不进 `words.json`。
