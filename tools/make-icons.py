#!/usr/bin/env python
"""重新生成 PWA 图标（添加主屏幕后用到的那个「词」图标）。

产出：
  icon-192.png / icon-512.png        普通图标
  icon-maskable-512.png              自适应图标（安卓会裁成圆形/方形，内容缩到安全区内）

依赖：Pillow；字体用系统里的微软雅黑/黑体。改配色或字样就改下面的 BG / FG / ACCENT 与 "词"。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc",
         r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc",
         "/System/Library/Fonts/PingFang.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc"]

BG = (23, 26, 33)       # 与深色主题一致
FG = (255, 255, 255)
ACCENT = (125, 151, 255)
GLYPH = "词"


def font_for(size):
    for path in FONTS:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise SystemExit("找不到可用的中文字体，无法绘制图标")


def draw(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, size, size], fill=BG)
        inner = size * 0.56
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=BG)
        inner = size * 0.62
    d.rounded_rectangle([size * 0.28, size * 0.17, size * 0.72, size * 0.17 + size * 0.035],
                        radius=size * 0.02, fill=ACCENT)
    font = font_for(int(inner))
    box = d.textbbox((0, 0), GLYPH, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1] + size * 0.04), GLYPH, font=font, fill=FG)
    return img


def main():
    for name, size, maskable in [("icon-192.png", 192, False),
                                 ("icon-512.png", 512, False),
                                 ("icon-maskable-512.png", 512, True)]:
        path = ROOT / name
        draw(size, maskable).save(path, "PNG", optimize=True)
        print(f"wrote {path.name}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
