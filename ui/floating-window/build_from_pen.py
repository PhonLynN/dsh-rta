#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rebuild index.html from the pen.dev html-css export, so every design value
(size / material / radius / font / icon / spacing) is copied verbatim instead of
being guessed from screenshots.

Source of truth:
  C:/Users/PhonLynN/.pencil/documents/28b8b5e9-b60b-4eca-a30b-be38425279b4/_exports/review/rta-reference.html
  (exported from RTA.pen frame PrC7t by the pen.dev canvas exporter)

Usage: python build_from_pen.py
"""
import re
import sys

REF = (r"C:/Users/PhonLynN/.pencil/documents/28b8b5e9-b60b-4eca-a30b-be38425279b4/"
       r"_exports/review/rta-reference.html")
OUT = r"C:/Users/PhonLynN/dsh_Workspace/dsh-RTA-dev/ui/floating-window/index.html"


def slice_element(s, start):
    """Return the full markup of the element that begins at `start`."""
    m = re.match(r"<([\w-]+)", s[start:])
    if not m:
        raise ValueError("not a tag at %d" % start)
    tag = m.group(1)
    depth = 0
    i = start
    while True:
        i = s.find("<", i)
        if i < 0:
            raise ValueError("unterminated <%s>" % tag)
        if s.startswith("</", i):
            m2 = re.match(r"</([\w-]+)", s[i:])
            if m2 and m2.group(1) == tag:
                depth -= 1
                i = s.find(">", i) + 1
                if depth == 0:
                    return s[start:i]
                continue
            i = s.find(">", i) + 1
        else:
            m2 = re.match(r"<([\w-]+)", s[i:])
            if m2 and m2.group(1) == tag:
                j = i
                quote = None
                while j < len(s):
                    c = s[j]
                    if quote:
                        if c == quote:
                            quote = None
                    else:
                        if c in "\"'":
                            quote = c
                        elif c == ">":
                            break
                    j += 1
                if s[j - 1] != "/":
                    depth += 1
                i = j + 1
            else:
                i = s.find(">", i) + 1


def find_by_name(s, name):
    needle = 'data-pencil-name="%s"' % name
    i = s.find(needle)
    if i < 0:
        raise SystemExit("missing node: " + name)
    return slice_element(s, s.rfind("<", 0, i))


def replace_once(s, old, new):
    if old not in s:
        raise SystemExit("pattern not found: %r" % old[:80])
    return s.replace(old, new, 1)


def move_to(s, left, top):
    s2 = re.sub(r"left: [0-9.]+px;", "left: %dpx;" % left, s, count=1)
    s2 = re.sub(r"top: [0-9.]+px;", "top: %dpx;" % top, s2, count=1)
    return s2


def set_text_node(s, text, name="Text"):
    """Replace the inner text of the first text node called `name`."""
    pat = re.compile(
        r'(<div\s+data-pencil-name="%s"\s+style=[^>]*>)(.*?)(</div>)' % name,
        re.S)
    m = pat.search(s)
    if not m:
        raise SystemExit("text node %s not found" % name)
    return s[:m.start()] + m.group(1) + "\n%s\n" % text + m.group(3) + s[m.end():]


src = open(REF, encoding="utf-8").read()

messages_card = move_to(find_by_name(src, "Messages Card"), 0, 0)
messages_content = move_to(find_by_name(src, "Messages Content"), 0, 0)
composer_card = move_to(find_by_name(src, "Composer Card"), 0, 534)
composer_content = move_to(find_by_name(src, "Composer Content"), 0, 534)

# asset paths (design references files next to the export, app keeps them in assets/)
messages_content = messages_content.replace("url('sheet.png')", "url('assets/sheet.png')")

# ---- exact copy texts from the .pen design -------------------------------
# generic text replacement by looking inside a named subtree
def sub_inside(s, parent, pattern, repl, count=1):
    block = find_by_name(s, parent)
    block2 = re.sub(pattern, repl, block, count=count, flags=re.S)
    return s.replace(block, block2, 1)


# Pill label
messages_content = sub_inside(
    messages_content, "Status Pill",
    r'(<div\s+data-pencil-name="Pill Label"\s+style=[^>]*>).*?(</div>)',
    r"\1已启用 00:34\2")

# conversation switch label
messages_content = sub_inside(
    messages_content, "Conversation Switch",
    r'(<div\s+data-pencil-name="Label"\s+style=[^>]*>).*?(</div>)',
    r"\1默认对话\2")

# AI message 1
messages_content = sub_inside(
    messages_content, "AI Message 1",
    r'(<div\s+data-pencil-name="Text"\s+style=[^>]*>).*?(</div>)',
    r"\1看到了，你在 DSH 的插件页。右上角那个「实验性插件」的开关，要我帮你一起看吗？\2")

# user bubble
messages_content = sub_inside(
    messages_content, "Bubble",
    r'(<div\s+data-pencil-name="Text"\s+style=[^>]*>).*?(</div>)',
    r"\1先看看这个玻璃面板的对比度，别把字透没了\2")

# AI message 2 text
messages_content = sub_inside(
    messages_content, "AI Message 2",
    r'(<div\s+data-pencil-name="Text"\s+style=[^>]*>).*?(</div>)',
    r"\1这是刚才那帧的拼图，红框里是 DeepSeek 的标记。\2")

# chip label
messages_content = sub_inside(
    messages_content, "Chip",
    r'(<div\s+data-pencil-name="Label"\s+style=[^>]*>).*?(</div>)',
    r"\1R2 · bbox 655,332 · 241×82\2")

# screen status text
messages_content = sub_inside(
    messages_content, "Screen Status",
    r'(<div\s+data-pencil-name="Text"\s+style=[^>]*>).*?(</div>)',
    r"\1正在观看 DeepSeek Harness\2")

# ---- composer: real input instead of placeholder + fake caret -------------
composer_content = sub_inside(
    composer_content, "Permission",
    r'(<div\s+data-pencil-name="Label"\s+style=[^>]*>).*?(</div>)',
    r"\1完全权限\2")
composer_content = sub_inside(
    composer_content, "Model",
    r'(<div\s+data-pencil-name="Label"\s+style=[^>]*>).*?(</div>)',
    r"\1V4.1-Flash\2")

# placeholder div -> real input (same box, no fake caret)
ph_style = re.search(
    r'<div\s+data-pencil-name="Placeholder"\s+style=\'([^\']*)\'', composer_content)
if not ph_style:
    raise SystemExit("placeholder style not found")
ph = find_by_name(composer_content, "Placeholder")
ph_new = ('<input id="chatInput" class="chat-input" type="text" '
          'aria-label="输入消息" autocomplete="off" '
          "placeholder=\"说说你在看什么…\">")
composer_content = composer_content.replace(ph, ph_new, 1)
caret = find_by_name(composer_content, "Caret")
composer_content = composer_content.replace(caret, "", 1)

# give the composer a stable class hook
composer_content = replace_once(
    composer_content, 'data-pencil-name="Composer Content"',
    'data-pencil-name="Composer Content" id="composer"')

html = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RTA 悬浮窗</title>
<link rel="stylesheet" href="./styles.css">
</head>
<body>
<div id="stage">
<div id="rtaWindow" class="rta-window">
__MESSAGES_CARD__
__MESSAGES_CONTENT__
__COMPOSER_CARD__
__COMPOSER_CONTENT__
</div>
</div>
<button id="miniPill" class="mini-pill" type="button" aria-label="展开 RTA 悬浮窗">
  <span class="mini-pill__dot"></span><span class="mini-pill__label">RTA</span>
  <span class="mini-pill__time" id="miniPillTime">00:34</span>
</button>
<script src="./app.js"></script>
</body>
</html>
"""

html = (html
        .replace("__MESSAGES_CARD__", messages_card)
        .replace("__MESSAGES_CONTENT__", messages_content)
        .replace("__COMPOSER_CARD__", composer_card)
        .replace("__COMPOSER_CONTENT__", composer_content))

open(OUT, "w", encoding="utf-8").write(html)
print("wrote", OUT, len(html), "bytes")
