#!/usr/bin/env python
"""从汉典（zdic.net）补词库缺的释义和拼音，直接并进 words.json。

来源与挑选规则（不硬猜）：
  div.xxjs-item__def      现代汉语释义，优先
  p.gy-sense__def         国语辞典释义，备用
  div.xxjs-reading-head   词头行，用来取拼音（另有 word-pronun-row / gy-reading 两处备用）

清洗：去掉混进来的标签与方括号拉丁残渣；以《…》引文开头的只保留引文之后的释义；
半角标点统一全角。写入的每条都带 src="汉典" 与 srcUrl 便于逐条复核。

用法：
    python tools/fetch-han-dian.py --dry-run            # 只报告，不改文件
    python tools/fetch-han-dian.py                      # 补释义与拼音，版本号递增
    python tools/fetch-han-dian.py --only missing-def   # 只补缺释义的
    python tools/fetch-han-dian.py --only missing-py    # 只补缺拼音的
    python tools/fetch-han-dian.py --limit 5            # 只跑前 5 条（试跑）
"""
import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from lxml import html as lhtml

ROOT = Path(__file__).resolve().parent.parent
WORDS = ROOT / "words.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
BASE = "https://www.zdic.net/hans/"
DELAY = 2.0
RETRIES = 2

ZHUYIN = re.compile(r"[ㄅ-ㄩˊˇˋ˙]")
# 拼音声调字母跨 Latin-1、扩展 A、扩展 B：é(00E9)、ā(0101)、ǎ(01CE)、ǔ(01D4) 都要覆盖
PINYIN_CHARS = "A-Za-z\u00c0-\u024f\u1e00-\u1eff· "
PINYIN_RE = re.compile(f"[{PINYIN_CHARS}]+")
LATIN = re.compile(r"[A-Za-zÀ-ÿĀ-ſ]")

DEF_LEADS = ["指", "意为", "意思是", "比喻", "形容", "表示", "引申为", "是"]
DEF_CUTS = [
    "，文段", "，排除", "，保留", "，当选", "，与", "，且", "，不能", "，不符", "，不符合",
    "，均符合", "，符合文意", "，符合", "，置于", "，逻辑", "，前文", "，横线", "，其中",
    "，文中", "，放入", "，能体现", "，可", "，所以", "，如“", "，通常", "，多用于", "，用于",
    "，A项", "，B项", "，C项", "，D项", "，侧重点", "，侧重", "，强调", "，而", "，而非",
    "，均", "，对应", "，填入", "，呼应", "，由", "，根据", "，常被", "，未提及", "，虽然",
    "，但", "，说明", "，表明", "，因此", "，可见", "，“", "，文章", "，题干", "，为中性",
    "，无法", "，比如", "，多搭配", "，多指", "；", ";", "。",
]
PUNCT = {",": "，", ";": "；", ":": "：", "!": "！", "?": "？"}


def clean_def(text):
    t = re.sub(r"<[^>]{1,40}>", "", text or "")
    t = re.sub(r"[\[［][^\]］]{0,40}[\]］]", "", t)
    t = re.sub(r"（\s*[A-Za-z][^）]{0,40}）", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    if t[:1] in "《「“":
        parts = re.split(r"[》」”]\s*", t, maxsplit=1)
        tail = parts[1] if len(parts) > 1 else t
        m = re.search(r"(?:意思是|后来用|比喻|形容|指|表示)(.+)", tail)
        t = m.group(1) if m else tail
    t = t.split("后来用")[0]
    t = "".join(PUNCT.get(ch, ch) for ch in t)
    return re.sub(r"\s+", "", t).strip("，。；：: ")


def initials(pinyin):
    out = []
    for syllable in (pinyin or "").split():
        base = unicodedata.normalize("NFD", syllable[0]).encode("ascii", "ignore").decode()
        if base and base.isalpha():
            out.append(base.lower())
    return "".join(out)


def clean_head(raw_head, word):
    body = re.sub(r"\s+", " ", raw_head).strip()
    if body.startswith(word):
        body = body[len(word):]
    if body.startswith("拼音"):
        body = body.split("拼音")[-1]
    body = ZHUYIN.split(body)[0]
    body = re.sub(r"[（(].*?[)）]", "", body)
    body = re.sub(r"\s+", " ", body).strip(" ·，,")
    if len(body) >= 2 and PINYIN_RE.fullmatch(body) and LATIN.search(body):
        return body
    return ""


def parse(word, raw):
    doc = lhtml.fromstring(raw)
    for tag in ("style", "script"):
        for node in doc.xpath("//" + tag):
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)

    defn = ""
    for sel in ("//div[contains(@class,'xxjs-item__def')]",
                "//p[contains(@class,'gy-sense__def')]",
                "//div[contains(@class,'czjc-gloss')]"):
        nodes = doc.xpath(sel)
        if nodes:
            candidate = " ".join(nodes[0].text_content().split()).strip()
            if len(candidate) >= 4:
                defn = clean_def(candidate)
                break

    pinyin = ""
    for sel in ("//div[contains(@class,'xxjs-reading-head')]",
                "//div[contains(@class,'word-pronun-row')]",
                "//div[contains(@class,'gy-reading')]"):
        nodes = doc.xpath(sel)
        if nodes:
            pinyin = clean_head(nodes[0].text_content(), word)
            if pinyin:
                break
    return defn, pinyin


def fetch(word):
    """取汉典词条页。

    404 直接判定「汉典没收录」，立刻返回 None、不重试——退避只留给限流/网络故障。
    否则遇到汉典本来就没有的词会白等三次退避（实测每个词 20 秒，几百个词就是几十分钟）。
    """
    url = BASE + urllib.parse.quote(word)
    last = ""
    for attempt in range(1, RETRIES + 2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
            return urllib.request.urlopen(req, timeout=25).read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            last = f"HTTP {exc.code}"
        except Exception as exc:
            last = type(exc).__name__
        time.sleep(3 * attempt)
    raise RuntimeError(last or "unknown")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["missing-def", "missing-py", "both"], default="both")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条（试跑用）")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写回词库")
    ap.add_argument("--words", default=str(WORDS), help="词库文件路径（默认仓库根的 words.json）")
    args = ap.parse_args()

    words_path = Path(args.words).resolve()
    db = json.loads(words_path.read_text(encoding="utf-8"))
    entries = {w["w"]: w for w in db["words"]}

    def needs(e):
        if args.only == "missing-def":
            return not e.get("def")
        if args.only == "missing-py":
            return not e.get("py")
        return (not e.get("def")) or (not e.get("py"))

    targets = [w for w in db["words"] if needs(w)]
    if args.limit:
        targets = targets[: args.limit]
    print(f"待补 {len(targets)} 条（--only {args.only}）")

    def_added = py_added = missing = failed = 0
    for i, entry in enumerate(targets, 1):
        word = entry["w"]
        try:
            raw = fetch(word)
        except Exception as exc:
            failed += 1
            print(f"{i:3d}/{len(targets)} {word:<8s} ! {exc}")
            sys.stdout.flush()
            time.sleep(DELAY)
            continue
        if raw is None:   # 汉典没收录，不必再试
            missing += 1
            print(f"{i:3d}/{len(targets)} {word:<8s} - 汉典未收录")
            sys.stdout.flush()
            time.sleep(0.3)
            continue
        defn, pinyin = parse(word, raw)
        marks = []
        if defn and not entry.get("def"):
            entry["def"] = defn
            entry["src"] = "汉典"
            entry["srcUrl"] = BASE + urllib.parse.quote(word)
            def_added += 1
            marks.append("释义")
        if pinyin and not entry.get("py"):
            entry["py"] = pinyin
            entry["abbr"] = initials(pinyin)
            py_added += 1
            marks.append("拼音")
        print(f"{i:3d}/{len(targets)} {word:<8s} {'+'.join(marks) if marks else '无新增'}"
              + (f"  {defn[:40]}" if defn and "释义" in marks else ""))
        sys.stdout.flush()
        time.sleep(DELAY)

    # 统一按拼音重算首字母，避免手写时声母顺序出错
    for e in db["words"]:
        if e.get("py"):
            want = initials(e["py"])
            if want:
                e["abbr"] = want

    if args.dry_run:
        print(f"\n[dry-run] 将会新增释义 {def_added} 条、拼音 {py_added} 条；"
              f"汉典未收录 {missing} 条、请求失败 {failed} 条")
        return
    parts = db["version"].rsplit(".", 1)
    db["version"] = parts[0] + "." + str(int(parts[1]) + 1)
    words_path.write_text(json.dumps(db, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    still = [e["w"] for e in db["words"] if not e.get("def")]
    print(f"\n新增释义 {def_added} 条、拼音 {py_added} 条；汉典未收录 {missing} 条、请求失败 {failed} 条；"
          f"版本 -> {db['version']}")
    print(f"仍缺释义 {len(still)} 条：{'、'.join(still)}")


if __name__ == "__main__":
    main()
