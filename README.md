# 考公词语积累器

一个单文件网页 + 一份公开词库 JSON，实现 [PLAN.md](PLAN.md) 里的三个功能：查询词语、频率统计、刷词模式。
电脑和手机浏览器都能打开，纯静态，没有后端，没有依赖，数据不上传任何服务器。

## 三个功能怎么落地

**查询词语（功能一）** — [index.html](index.html) 的「查询」页，支持四种输入：完整词语、拼音首字母（`ycej` → 一蹴而就）、带声调拼音、释义关键词。
点开一个词给出六个字段：意思和要点、词性、褒贬意、用来修饰什么、主语应该是谁、使用次数。字段正好对应你计划里写的那几项。

词库没填的字段可以自己补：详情页点「补充说明」，褒贬直接点选，词性/用来修饰/主语/易混辨析/其他说明都能手写。补充存在本机
`localStorage`（键 `kg.notes.v1`），展示时覆盖词库的空字段、并标上「补充」标签；导出的备份会带出去，换设备导入即可。

**频率统计（功能二）** — 「频率统计」页按查询次数排序，带占比条。
「数据」页可以粘贴 AI 做试卷分析时收录的词表，一行一个词；同一个词出现几次就计几次收录，多出来的记入「重复」并标黄，不在词库里的词先收进来标记「待补释义」。

**刷词模式（功能三）** — 「刷词模式」页把库里的词做成卡片，一张张过：`←` `→` 切换，空格翻开，`1` 没掌握 / `2` 已掌握，可以只看未掌握的词。

**更新检测** — 每次打开都会带时间戳请求 `words.json`（`cache: no-store`），版本号变了就替换并提示 `旧版本 → 新版本`。
双击打开（`file://`）时浏览器禁止读取同目录 JSON，页面会自动跳过联网、沿用缓存的词库并给出提示。

## 跑起来

本地看（推荐，联网检测更新才有效）：

```bash
cd <仓库目录>
python -m http.server 8787
# 浏览器打开 http://127.0.0.1:8787/
```

直接双击 `index.html` 也能用，只是首次需要手动导入一次词库（「数据」页 → 导入词库文件）。

发布到 GitHub Pages（对应你计划里的「github 上设置一个公开访问的看板库」）：

1. 把仓库推到 GitHub。
2. Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`。
3. 地址形如 `https://<用户名>.github.io/<仓库名>/`，手机直接访问这个地址即可，词库更新检测自动生效。

## 词库格式

[words.json](words.json) 是唯一事实来源。手工整理的词条字段齐全：

```json
{
  "w": "一蹴而就",
  "abbr": "ycej",
  "py": "yī cù ér jiù",
  "def": "……意思和要点",
  "key": "……辨析要点",
  "pos": "成语·动词性",
  "tone": "贬",
  "modifies": "多修饰事业、改革、学业",
  "subject": "主语多为“事情、工程”",
  "tags": ["逻辑填空", "高频"]
}
```

从真题里采集来的词条是稀疏的，只有 `w` 必填，另有 `source`（真题出处）、`seen`/`hit`（在选项里出现次数 / 其中作为正确答案的次数）：

```json
{
  "w": "不言而喻",
  "def": "不用说就可以明白，也形容道理很浅显",
  "tags": ["对应关系", "前后呼应"],
  "source": "2025年河北省公务员录用考试《行测》题（网友回忆版） 第57题",
  "seen": 2,
  "hit": 1
}
```

没有 `def` 的词条会被应用标为「待补释义」。加词就是往 `words` 数组里追加一条，然后改 `version`
（`日期.序号`）——客户端下次打开就会拉取新版本。`abbr` 是拼音首字母，用来支持快速检索。

当前 328 条：12 条手工整理的高频成语（字段齐全）+ 316 条从真题选项采集（174 条带解析原文释义，
其余待补）。

## 从真题收词

[milanote/collect-exam-words.py](milanote/collect-exam-words.py) 读一份粉笔练习页的浏览器存档，
把**选项里的词**全部收下来、去重，并把解析原文里的释义、搭配提示、真题出处一并结构化：

```bash
cd milanote
python collect-exam-words.py "专项智能练习（逻辑填空）10.15.html" \
    -o out-exam/collected.json --report out-exam/review.md --merge ../words.json
```

- `out-exam/collected.json` — 原始收获：40 道题的题干、四个选项、正确答案、你的答案、考点、真题来源，以及每个词的全部出现记录。
- `out-exam/review.md` — 人工复核表：词 / 释义（解析原文）/ 常形容 / 褒贬 / 出现次数 / 是否正确答案 / 你有没有选错 / 真题出处。
- `--merge` 只追加库里没有的词；已有的词只补 `source`/`seen`/`hit`，绝不覆盖手工写的释义。合并前会自动留一份 `words.before-merge.json`。
- `python check-exam-words.py` 复核采集质量（释义里是否混入了解题推理、有没有跑飞的超长释义）。

## 数据存放与备份

查询次数、掌握情况、收录与重复计数都存在浏览器的 `localStorage`（键 `kg.db.v1` / `kg.stats.v1` / `kg.local.v1`），换设备不会同步。
「数据」页可以导出统计 JSON，也可以把导出的文件再导回来合并；从试卷分析里新收的「待补释义」词会一并带出，方便你补全后合并进 `words.json`。

## 仓库结构

```
index.html                网页应用（单文件，无依赖）
words.json                公开词库（版本号驱动更新）
PLAN.md                   开发计划（从 Milanote 看板提取）
milanote/                 工具链，见 milanote/README.md
  milanote-dump.mjs       走 API 在线抓看板 → JSON / Markdown / Canvas
  parse-saved-html.py     从浏览器存档离线还原看板
  collect-exam-words.py   从练习页存档采集选项词 → 结构化词库
  check-exam-words.py     采集质量复核
  test-page-logic.mjs     网页逻辑测试（桩化 DOM，21 项）
  check-page.py           网页静态检查（脚本语法 / 词库字段 / 结构 / id 引用）
  out-exam/               10.15 这套题的全部产物
```

## 验证

```bash
cd milanote
node test-page-logic.mjs      # 搜索排序、拼音检索、重复计数、刷词标记、file:// 分支
python check-page.py          # 内联脚本语法、词库字段完整性、HTML 结构与 id 引用
python check-exam-words.py    # 采集到的释义是否干净
```

三个脚本都要以「无 FAIL / all checks passed」结束才算通过。
