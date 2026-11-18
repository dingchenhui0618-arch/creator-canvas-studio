# -*- coding: utf-8 -*-
import os, io, json
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_BREAK
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

ROOT = r'D:\Projects\creator-canvas-studio'
OUT = os.path.join(ROOT, 'docs', 'copyright')
SW_NAME = 'VisionQA 多智能体会话画布创作平台'
SW_VER = 'V1.0'
PAGE_LINES = 50
FRONT_PAGES = 30
BACK_PAGES = 30

EXCLUDE_DIRS = {'node_modules','dist','build','release-desktop','data','.git','.github',
                '.tmp-canvas','.tmp-drill','.tmp-ident','.tmp-ops','.tmp-qa','.tmp-smtp'}
CODE_EXT = {'.ts', '.tsx', '.mjs', '.js', '.cjs'}
TOPS = ['src', 'server', 'electron', 'worker']

PRIORITY = [
    'src/main.tsx',
    'src/App.tsx',
    'src/router.ts',
    'src/nav.ts',
    'src/domain/types.ts',
    'src/canvas/types.ts',
    'src/canvas/catalog.ts',
    'src/canvas/serialize.ts',
    'src/canvas/layout.ts',
    'src/canvas/FlowNode.tsx',
    'src/canvas/Palette.tsx',
    'src/canvas/Inspector.tsx',
    'src/canvas/RunDrawer.tsx',
    'src/pages/CanvasPage.tsx',
    'src/pages/BoardPage.tsx',
    'src/api/flows.ts',
    'src/api/agents.ts',
    'src/api/canvasSession.ts',
    'server/index.mjs',
    'server/routes/canvas.mjs',
    'server/flows.mjs',
    'server/canvas-session.mjs',
    'server/agentChat.mjs',
    'server/agents.mjs',
    'electron/agent/loop.mjs',
    'electron/agent/tools.mjs',
    'electron/agent/memory.mjs',
    'electron/agent/protocol.mjs',
    'electron/main.cjs',
    'electron/preload.mjs',
    'server/auth.mjs',
    'server/review.mjs',
    'server/judge.mjs',
    'server/vision.mjs',
    'server/waterline.mjs',
    'server/wait-queue.mjs',
    'server/heavy-lease.mjs',
    'server/gateway.mjs',
    'server/credits.mjs',
    'server/projects.mjs',
    'server/delivery-ledger.mjs',
    'server/routes/projects.mjs',
    'server/routes/review.mjs',
    'server/routes/agents.mjs',
]

def is_test(rel):
    p = rel.replace(os.sep, '/')
    return p.startswith('test/') or '.test.' in p

def walk(base):
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in CODE_EXT:
                rel = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace(os.sep, '/')
                if not is_test(rel):
                    out.append(rel)
    return out

allfiles = []
for top in TOPS:
    allfiles += walk(os.path.join(ROOT, top))
allfiles = sorted(set(allfiles))

order = []
for p in PRIORITY:
    if p in allfiles and p not in order:
        order.append(p)

def rank(rel):
    keys = ['src/canvas/', 'src/pages/', 'src/api/', 'src/domain/', 'src/components/',
            'src/auth/', 'src/lib/', 'src/desktop/', 'src/brand/', 'src/state/', 'src/',
            'server/', 'server/routes/', 'electron/agent/', 'electron/', 'worker/']
    for i, k in enumerate(keys):
        if rel.startswith(k):
            return i
    return 99

rest = [f for f in allfiles if f not in order]
rest.sort(key=lambda r: (rank(r), r))
order += rest

def disp_width(ch):
    return 2 if ord(ch) > 0x2E7F else 1

def wrap_line(s, limit=98, cont_limit=96):
    if not s:
        return ['']
    out, cur = [], ''
    cur_limit = limit
    for ch in s:
        if sum(disp_width(c) for c in cur) + disp_width(ch) > cur_limit and cur.strip():
            cut = cur.rfind(' ')
            if cut > cur_limit // 3:
                out.append(cur[:cut].rstrip())
                cur = '  ' + cur[cut + 1:].lstrip() + ch
            else:
                out.append(cur.rstrip())
                cur = '  ' + ch
            cur_limit = cont_limit + 2
        else:
            cur += ch
    out.append(cur.rstrip())
    return out

lines_all = []
used = []
for rel in order:
    path = os.path.join(ROOT, rel.replace('/', os.sep))
    try:
        with io.open(path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read().splitlines()
    except Exception as e:
        print('skip', rel, e)
        continue
    body = [l.rstrip() for l in content if l.strip()]
    if not body:
        continue
    lines_all.append('/* ===== 文件：%s ===== */' % rel)
    for ln in body:
        lines_all.extend(wrap_line(ln))
    used.append([rel, len(body)])

total = len(lines_all)
need = PAGE_LINES * FRONT_PAGES
front = lines_all[:need]
tail = lines_all[-need:]
assert len(front) == need and len(tail) == need

def set_cn_font(run, name='Consolas', size=8.5, east='宋体'):
    run.font.name = name
    run.font.size = Pt(size)
    run._element.rPr.rFonts.set(qn('w:eastAsia'), east)

def add_page_field(paragraph, prefix='第 ', suffix=' 页'):
    r = paragraph.add_run(prefix)
    fld = OxmlElement('w:fldSimple')
    fld.set(qn('w:instr'), 'PAGE')
    t = OxmlElement('w:t')
    t.text = '1'
    fld.append(t)
    paragraph._p.append(fld)
    paragraph.add_run(suffix)

doc = Document()
sec = doc.sections[0]
sec.page_width = Cm(21.0)
sec.page_height = Cm(29.7)
sec.top_margin = Cm(1.9)
sec.bottom_margin = Cm(1.6)
sec.left_margin = Cm(2.0)
sec.right_margin = Cm(1.8)
sec.header_distance = Cm(0.9)
sec.footer_distance = Cm(0.8)

style = doc.styles['Normal']
style.font.name = 'Consolas'
style.font.size = Pt(8.5)
style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
pf = style.paragraph_format
pf.space_before = Pt(0)
pf.space_after = Pt(0)
pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
pf.line_spacing = Pt(13.8)

hp = sec.header.paragraphs[0]
hp.text = ''
hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
r1 = hp.add_run(SW_NAME + ' ' + SW_VER + '　源程序')
set_cn_font(r1, '宋体', 9, '宋体')

fp = sec.footer.paragraphs[0]
fp.text = ''
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
add_page_field(fp)
for r in fp.runs:
    set_cn_font(r, '宋体', 9, '宋体')

def emit(chunk, add_break=True):
    for line in chunk:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        p.paragraph_format.line_spacing = Pt(13.8)
        run = p.add_run(line if line else ' ')
        set_cn_font(run)
    if add_break:
        pb = doc.add_paragraph()
        pb.paragraph_format.space_before = Pt(0)
        pb.paragraph_format.space_after = Pt(0)
        pb.add_run().add_break(WD_BREAK.PAGE)

sentinel = '/* …… 此处省略源程序中间部分，后 30 页为源程序末尾部分 …… */'
front_pages = [front[i * PAGE_LINES:(i + 1) * PAGE_LINES] for i in range(FRONT_PAGES)]
tail = [sentinel] + tail[1:]
back_pages = [tail[i * PAGE_LINES:(i + 1) * PAGE_LINES] for i in range(BACK_PAGES)]

allpages = front_pages + back_pages
for idx, chunk in enumerate(allpages):
    emit(chunk, add_break=(idx < len(allpages) - 1))

out_name = '01_源程序文档_%s_%s.docx' % (SW_NAME.replace(' ', ''), SW_VER)
doc.save(os.path.join(OUT, out_name))
print('pages', len(allpages), 'lines in doc', len(allpages) * PAGE_LINES)
print('total source lines', total, 'files used', len(used))
print('first files:', [u[0] for u in used[:10]])
print('last files:', [u[0] for u in used[-6:]])
json.dump({'total_lines': total, 'files_used': len(used), 'order': used},
          open(os.path.join(OUT, 'source-order.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
