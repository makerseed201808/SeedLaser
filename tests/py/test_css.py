"""web/styles.css 的结构检查（不需要浏览器）。运行：.venv/bin/python tests/py/test_css.py
背景（2026-11-12 检查发现）：删掉「重叠弹窗」的样式时只删了第一行，留下半条没有选择器的规则（多出一个 }）。
浏览器不报错，但会把它后面紧跟的那条规则（.sk-boolhint）一起丢掉。这里检查：花括号配对、不会在规则外面出现 }、
规则外面没有落单的「属性: 值;」，以及样式表里的 class 至少在前端代码里出现过一次（没人用的样式不留）。"""
import os
import re

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
css = open(os.path.join(ROOT, 'web', 'styles.css'), encoding='utf-8').read()
text = re.sub(r'/\*.*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), css, flags=re.S)      # 去掉注释，保留行号
text = re.sub(r'"[^"\n]*"|\'[^\'\n]*\'', lambda m: ' ' * len(m.group(0)), text)                  # 去掉字符串

depth, line, problems, prelude = 0, 1, [], ''
for ch in text:
    if ch == '\n':
        line += 1
    if ch == '{':
        if depth == 0 and (not prelude.strip() or ';' in prelude):
            problems.append(f'第 {line} 行：{{ 前面不是一个选择器（{prelude.strip()[:40]!r}）')
        depth += 1
        prelude = ''
    elif ch == '}':
        depth -= 1
        prelude = ''
        if depth < 0:
            problems.append(f'第 {line} 行：多出一个 }}（前面那条规则缺了选择器那一行？）')
            depth = 0
    elif depth == 0:
        prelude += ch
assert depth == 0, f'文件结尾还有 {depth} 个 {{ 没有配对'
assert not prelude.strip(), ('文件结尾有落单的内容', prelude.strip()[:80])
assert not problems, problems

# 样式表里的 class 都要有人用（在 web/ 的脚本和页面里出现过）
used = ''
for f in ('index.html', 'app.js', 'workshop.js', 'sketch2d.js', 'sketch-import.js'):
    used += open(os.path.join(ROOT, 'web', f), encoding='utf-8').read()
words = set(re.findall(r'[A-Za-z_][A-Za-z0-9_-]*', used))
classes = set()
for m in re.finditer(r'([^{}]+)\{', text):
    sel = m.group(1)
    if sel.strip().startswith('@'):
        continue
    classes.update(re.findall(r'\.([A-Za-z_][A-Za-z0-9_-]*)', sel))
unused = sorted(c for c in classes if c not in words)
assert not unused, ('样式表里有没人用的 class（删掉对应的规则，或确认是不是脚本里拼出来的名字）', unused)
print(f'PASS test_css：styles.css 花括号配对、没有落单的规则；{len(classes)} 个 class 都在前端代码里用到')
