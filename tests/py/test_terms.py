"""A7 术语统一：界面文字里不能出现旧叫法（术语表见 CLAUDE.md「术语表」）。
扫 web/*.js、web/index.html 里的代码（跳过注释），以及后端翻译出的几个关键词。
运行：.venv/bin/python tests/py/test_terms.py"""
import glob
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, ROOT)

# 旧叫法 → 应该用的词
BANNED = {'连接点': '水口', '划线': '描线', '刻字': '文字 / 雕刻', '卡扣': '卡榫', '榫卯': '卡榫', '去装配': '3D 装配',
          '板材': '材料', '切缝补偿': '激光补偿', '蚀刻': '雕刻', '生成 3D ·': '3D 装配'}

bad = []
files = glob.glob(os.path.join(ROOT, 'web', '*.js')) + [os.path.join(ROOT, 'web', 'index.html')]
for f in files:
    in_block = False
    for n, line in enumerate(open(f, encoding='utf-8'), 1):
        st = line.strip()
        if in_block:
            if '*/' in st:
                in_block = False
            continue
        if st.startswith('/*') and '*/' not in st:
            in_block = True
            continue
        if st.startswith(('//', '*', '/*', '<!--')):
            continue
        code = re.sub(r'(^|\s)//\s.*$', '', line)              # 行尾注释
        for w, good in BANNED.items():
            if w in code:
                bad.append(f'{os.path.relpath(f, ROOT)}:{n}「{w}」→ 应为「{good}」：{code.strip()[:80]}')

import backend  # noqa: E402
for msgid, want in [('Finger Joint', '卡榫'), ('Settings for Finger Joints', '卡榫'), ('finger joints', '卡榫'),
                    ('add current date etching to each piece', '雕刻'), ('add identifier etching to each piece', '雕刻'),
                    ('spacing around parts (multiples of thickness [: extra space in mm])', '板件')]:
    got = backend.tr(msgid)
    if want not in got:
        bad.append(f'翻译「{msgid}」= 「{got}」，应包含「{want}」')

assert not bad, '界面里还有旧叫法：\n' + '\n'.join(bad)
print(f'PASS test_terms：{len(files)} 个前端文件和后端关键翻译里没有旧叫法（{"、".join(BANNED)}）')
