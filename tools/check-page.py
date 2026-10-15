#!/usr/bin/env python
"""网页静态检查：内联脚本语法、词库字段、HTML 结构与 id 引用、功能是否还在。

用法：
    python tools/check-page.py            # 在仓库任意位置调用都行
    NODE=/path/to/node python tools/check-page.py

以「all checks passed」结束才算通过；有问题会逐条列出并返回非零退出码。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from lxml import html as lhtml

ROOT = Path(__file__).resolve().parent.parent
NODE = os.environ.get("NODE") or shutil.which("node") or "node"
problems = []

page = (ROOT / "index.html").read_text(encoding="utf-8")
script = re.findall(r"<script[^>]*>(.*?)</script>", page, re.S)[-1]

# 1. 已删除的功能不能残留（<textarea> 不在禁用之列：补充说明合法使用它）
for gone in ["importWordList", "import-text", "btn-import\"", "K_LOCAL", "state.local",
             "saveLocal", "localWords", "导入试卷分析词表"]:
    hits = page.count(gone)
    if hits:
        problems.append(f"leftover {gone!r} x{hits}")

# 2. 退役的存储键只应出现在「清除本机数据」里，用来把老设备上的残留一并删掉
legacy = page.count('"kg.local.v1"')
if legacy != 1:
    problems.append(f'expected exactly one "kg.local.v1" mention (legacy cleanup), found {legacy}')
if re.search(r"function clearLocalData[\s\S]{0,700}K_LEGACY_LOCAL", page) is None:
    problems.append("clearLocalData does not purge the retired key")

# 3. 关键功能必须在位
for need in ['id="btn-clear-all"', "function clearLocalData", "localStorage.removeItem",
             "K_LEGACY_LOCAL", "kg.notes.v1", "function saveNote", "data-edit",
             'id="btn-fullscreen"', "function toggleFullscreen", "function syncFullscreenButton",
             'rel="manifest"', "apple-mobile-web-app-capable", "overscroll-behavior"]:
    if need not in page:
        problems.append(f"missing {need!r}")

# 3b. 全屏清单与图标：装到主屏幕后要能真正全屏
manifest_path = ROOT / "manifest.json"
if not manifest_path.exists():
    problems.append("manifest.json missing")
elif 'rel="manifest"' not in page or "manifest.json" not in page:
    problems.append("index.html does not link manifest.json")
else:
    mf = json.loads(manifest_path.read_text(encoding="utf-8"))
    if mf.get("display") != "fullscreen":
        problems.append(f"manifest display is {mf.get('display')!r}, expected 'fullscreen'")
    if not mf.get("start_url"):
        problems.append("manifest has no start_url")
    icons = mf.get("icons") or []
    if not icons:
        problems.append("manifest declares no icons")
    try:
        from PIL import Image
        have_pillow = True
    except ImportError:
        have_pillow = False
    for icon in icons:
        icon_path = ROOT / icon.get("src", "")
        if not icon_path.exists():
            problems.append(f"manifest icon missing on disk: {icon.get('src')}")
            continue
        want = icon.get("sizes", "")
        if have_pillow and "x" in want:
            with Image.open(icon_path) as im:
                expected = tuple(int(x) for x in want.split("x")[:2])
                if im.size != expected:
                    problems.append(f"{icon['src']}: is {im.size}, manifest says {want}")

# 4. 每个 $("id") 都要有对应元素；每个按钮都要接上线
ids = set(re.findall(r'\bid="([^"]+)"', page))
refs = set(re.findall(r'\$\("([^"]+)"\)', script))
missing = sorted(refs - ids)
if missing:
    problems.append(f"$() references missing ids: {missing}")
buttons = set(re.findall(r'<button[^>]*\bid="([^"]+)"', page))
unwired = sorted(b for b in buttons if f'$("{b}")' not in script)
if unwired:
    problems.append(f"buttons never wired: {unwired}")

# 5. 双击打开（file://）时仍要能手动导入词库
if 'id="file-input"' not in page or "function readFile" not in script:
    problems.append("file import path removed")

# 6. 内联脚本语法
tmp = Path(tempfile.gettempdir()) / "_check_page_inline.js"
tmp.write_text(script, encoding="utf-8")
res = subprocess.run([NODE, "--check", str(tmp)], capture_output=True, text=True)
if res.returncode != 0:
    problems.append("inline JS syntax error: " + res.stderr.strip()[:300])
tmp.unlink(missing_ok=True)

# 7. 词库 schema
db = json.loads((ROOT / "words.json").read_text(encoding="utf-8"))
allowed = {"w", "abbr", "py", "def", "key", "pos", "tone", "modifies", "subject",
           "tags", "source", "seen", "hit", "pending", "appearances", "src", "srcUrl"}
seen = set()
for e in db["words"]:
    if "w" not in e:
        problems.append("entry without w")
        continue
    unknown = set(e) - allowed
    if unknown:
        problems.append(f"{e['w']}: unexpected keys {sorted(unknown)}")
    if e["w"] in seen:
        problems.append(f"duplicate word {e['w']}")
    seen.add(e["w"])
    if e.get("tone") and e["tone"] not in ("褒", "贬", "中性"):
        problems.append(f"{e['w']}: odd tone {e['tone']!r}")
    if "tags" in e and not isinstance(e["tags"], list):
        problems.append(f"{e['w']}: tags is not a list")

withdef = sum(1 for e in db["words"] if e.get("def"))
srcs = {s: sum(1 for e in db["words"] if e.get("src") == s) for s in ("exam", "汉典", None)}
print(f"words.json: version={db['version']} count={len(db['words'])} unique={len(seen)} with-def={withdef}")
print(f"释义来源: {srcs}")
print(f"markup ids: {len(ids)}, $() refs: {len(refs)}, buttons: {len(buttons)}")
print(f"inline JS: {'parses' if res.returncode == 0 else 'BROKEN'}")
print("\n" + ("PROBLEMS:\n  " + "\n  ".join(problems) if problems else "all checks passed"))
sys.exit(1 if problems else 0)
