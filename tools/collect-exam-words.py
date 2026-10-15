#!/usr/bin/env python
"""从粉笔练习页的浏览器存档里采集「选项里的词」，并把解析里给出的释义一并结构化。

页面结构（实测）：
  div.questions-single-container   一道题
    div.choice-radio               一个选项（注意 ul.choice-radios 也含 'choice-radio'
                                   子串，必须按整词匹配，否则会把四个选项合排的那行当成选项 A）
    div.solution-choice-container  题干 + 选项 + 解析粘在一起的整块，解析在「视频解析」之后
  div.solution-keypoint-container  考点
  解析里对每个错项的写法：B项“力薄才疏”形容力量和才能都有限，多用来形容人，与“理论”搭配不当

用法：
    python tools/collect-exam-words.py 练习.html --report out.md        # 只出报告
    python tools/collect-exam-words.py 练习.html --json out.json        # 出结构化数据
    python tools/collect-exam-words.py 练习.html --merge ../words.json  # 把新词并进词库
"""
import argparse
import json
import re
import sys
from pathlib import Path

from lxml import html as lhtml

ROOT = Path(__file__).resolve().parent.parent
CN_WORD = re.compile(r"^[\u4e00-\u9fa5]{2,8}$")
DEF_LEADS = ["指", "意为", "意思是", "比喻", "形容", "表示", "引申为", "是"]
DEF_CUTS = [
    "，文段", "，排除", "，保留", "，当选", "，与", "，且", "，不能", "，不符", "，不符合",
    "，均符合", "，符合", "，置于", "，逻辑", "，前文", "，横线", "，其中", "，文中",
    "，放入", "，能体现", "，可", "，所以", "，如“", "，通常", "，多用于", "，用于",
    "，A项", "，B项", "，C项", "，D项", "，侧重点", "，侧重", "，强调", "，而", "，而非",
    "，均", "，对应", "，填入", "，呼应", "，由", "，根据", "，常被", "，未提及", "，虽然",
    "，但", "，说明", "，表明", "，因此", "，可见", "，“", "，文章", "，题干", "，为中性",
    "，无法", "，比如", "，多搭配", "，多指", "；", ";", "。",
]
QUOTE_GROUP = re.compile(r"([A-D])项\s*((?:[“\"][^”\"]+[”\"]\s*)+)([^。；;]{0,260})")
QUOTED = re.compile(r"[“\"]([^”\"]+)[”\"]")
OPTION_ROW = ".//*[contains(concat(' ', normalize-space(@class), ' '), ' choice-radio ')]"


def txt(el):
    return " ".join((el.text_content() or "").split())


def analysis_of(q):
    blob = ""
    for el in q.xpath(".//*[contains(@class,'solution-choice-container')]"):
        blob = txt(el)
        break
    if not blob:
        return ""
    for anchor in ("视频解析", "文字解析", "解析"):
        i = blob.rfind(anchor)
        if i >= 0:
            body = blob[i + len(anchor):]
            break
    else:
        return ""
    for stop in ("【文段出处】", "考点", "来源", "笔记"):
        j = body.find(stop)
        if j > 0:
            body = body[:j]
    return body.strip()


def options_of(q):
    out = []
    for el in q.xpath(OPTION_ROW):
        m = re.match(r"^\s*([A-D])\s*[.、]?\s*(.+)$", txt(el))
        if not m:
            continue
        label, body = m.group(1), m.group(2)
        words = [w for w in re.split(r"[\s、,，;；/]+", body) if CN_WORD.match(w)]
        if words and not any(label == l for l, _ in out):
            out.append((label, words))
    return out


def meta_of(q):
    tags = []
    for el in q.xpath(".//*[contains(@class,'solution-keypoint-container')]"):
        for part in re.split(r"[-\s]+", txt(el)):
            if part and part not in tags:
                tags.append(part)
    source = ""
    for el in q.xpath(".//*[contains(@class,'solution-choice-container')]"):
        m = re.search(r"来源(.{4,80}?)第(\d+)题", txt(el))
        if m:
            source = m.group(1).strip() + " 第" + m.group(2) + "题"
        break
    return tags, source


def definition_for(label, word, analysis):
    """解析里明确写了“X项“词”指…”，才算释义；只讲这道题怎么排除的一律不取。"""
    fallback = None
    for m in QUOTE_GROUP.finditer(analysis):
        if m.group(1) != label:
            continue
        if word not in [w.strip() for w in QUOTED.findall(m.group(2))]:
            continue
        tail = m.group(3).lstrip("，, ")
        lead = next((l for l in DEF_LEADS if tail.startswith(l)), None)
        if lead is None:
            fallback = fallback or {"def": "", "raw": m.group(0).strip()[:200]}
            continue
        body = tail[len(lead):]
        cut = len(body)
        for marker in DEF_CUTS:
            i = body.find(marker)
            if 0 < i < cut:
                cut = i
        defn = body[:cut].strip("，。；:： ")
        if word in defn:  # 释义后文再次出现该词，说明那是分析
            for i, ch in enumerate(defn):
                if ch == "，" and word in defn[i:]:
                    defn = defn[:i]
                    break
        defn = defn.strip("，。；:： ")
        if defn:
            return {"def": defn, "raw": m.group(0).strip()[:200]}
        fallback = fallback or {"def": "", "raw": m.group(0).strip()[:200]}
    return fallback


def harvest(path):
    doc = lhtml.fromstring(Path(path).read_bytes())
    questions = []
    for idx, q in enumerate(doc.xpath("//*[contains(@class,'questions-single-container')]"), 1):
        options = options_of(q)
        if not options:
            continue
        stem_el = q.xpath(".//*[contains(@class,'ti-content')]")
        correct = mine = ""
        for el in q.xpath(".//*[contains(@class,'correct-answer')]"):
            m = re.search(r"[A-D]", txt(el))
            if m:
                correct = m.group(0)
                break
        for el in q.xpath(".//*[contains(@class,'your-answer')]"):
            m = re.search(r"[A-D]", txt(el))
            if m:
                mine = m.group(0)
                break
        analysis = analysis_of(q)
        tags, source = meta_of(q)
        questions.append({
            "n": idx, "stem": txt(stem_el[0]) if stem_el else "", "options": options,
            "correct": correct, "mine": mine, "analysis": analysis, "tags": tags, "source": source,
        })
    return questions


def collect(questions):
    words = {}
    for q in questions:
        for label, opts in q["options"]:
            for i, word in enumerate(opts, 1):
                rec = words.setdefault(word, {"w": word, "def": "", "tags": [], "source": "",
                                              "seen": 0, "hit": 0, "appearances": []})
                rec["appearances"].append({"q": q["n"], "blank": i if len(opts) > 1 else None,
                                           "label": label, "correct": label == q["correct"]})
                rec["seen"] += 1
                if label == q["correct"]:
                    rec["hit"] += 1
                info = definition_for(label, word, q["analysis"])
                if info and info["def"] and len(info["def"]) > len(rec["def"]):
                    rec["def"] = info["def"]
                if q["source"] and not rec["source"]:
                    rec["source"] = q["source"]
                for tag in q["tags"]:
                    if tag not in rec["tags"]:
                        rec["tags"].append(tag)
    return words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html_file")
    ap.add_argument("--report", default=None, help="输出 Markdown 复核表")
    ap.add_argument("--json", default=None, help="输出结构化 JSON")
    ap.add_argument("--merge", default=None, help="把库里没有的新词并入这个 words.json")
    args = ap.parse_args()

    questions = harvest(args.html_file)
    words = collect(questions)
    withdef = sum(1 for r in words.values() if r["def"])
    print(f"题数 {len(questions)}，选项槽 {sum(len(o) for q in questions for _, o in q['options'])} 个，"
          f"去重后 {len(words)} 词，其中有解析释义 {withdef} 条")

    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps({"source": args.html_file, "questions": questions,
                                               "words": words}, indent=2, ensure_ascii=False) + "\n",
                                   encoding="utf-8")
        print("wrote", args.json)

    if args.report:
        order = sorted(words.values(), key=lambda r: (-r["seen"], r["w"]))
        lines = [f"# 选项词收录（{Path(args.html_file).name}）", "",
                 f"{len(questions)} 题 · 去重后 {len(words)} 词（其中 {withdef} 条取到解析释义）", "",
                 "释义取自该页解析原文；空表示解析没给这个词下定义。", "",
                 "| 词语 | 释义 | 出现 | 正确答案 | 真题来源 |", "| --- | --- | --- | --- | --- |"]
        for r in order:
            lines.append(f"| {r['w']} | {r['def'] or '—'} | {r['seen']} | {r['hit']} | {r['source'] or '—'} |")
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text("\n".join(lines) + "\n", encoding="utf-8")
        print("wrote", args.report)

    if args.merge:
        target = Path(args.merge)
        db = json.loads(target.read_text(encoding="utf-8"))
        existing = {w["w"] for w in db["words"]}
        added = 0
        for r in sorted(words.values(), key=lambda x: (-x["seen"], x["w"])):
            if r["w"] in existing:
                continue
            entry = {"w": r["w"]}
            if r["def"]:
                entry["def"] = r["def"]
                entry["src"] = "exam"
            if r["tags"]:
                entry["tags"] = r["tags"][:4]
            entry["seen"] = r["seen"]
            entry["hit"] = r["hit"]
            db["words"].append(entry)
            added += 1
        if added:
            parts = db["version"].rsplit(".", 1)
            db["version"] = parts[0] + "." + str(int(parts[1]) + 1) if len(parts) == 2 else "1"
            target.write_text(json.dumps(db, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"并入 {added} 条新词（已存在 {len(words) - added} 条跳过），版本 -> {db['version']}")
            print("新词还没释义/拼音的话，接着跑：python tools/fetch-han-dian.py")
        else:
            print(f"没有新词可并（这套题的 {len(words)} 个选项词都已在库里），词库与版本号未改动")


if __name__ == "__main__":
    sys.exit(main())
