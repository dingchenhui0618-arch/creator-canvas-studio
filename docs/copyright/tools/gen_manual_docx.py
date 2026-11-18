# -*- coding: utf-8 -*-
import os, json
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

ROOT = r'D:\Projects\creator-canvas-studio'
OUT = os.path.join(ROOT, 'docs', 'copyright')
SHOTS = os.path.join(OUT, 'shots')
SW_NAME = 'VisionQA 多智能体会话画布创作平台'
SW_VER = 'V1.0'
DOC_NAME = '软件说明书'

doc = Document()

# ---------- 页面与基础样式 ----------
sec = doc.sections[0]
sec.page_width = Cm(21.0)
sec.page_height = Cm(29.7)
sec.top_margin = Cm(2.4)
sec.bottom_margin = Cm(2.2)
sec.left_margin = Cm(2.4)
sec.right_margin = Cm(2.2)
sec.header_distance = Cm(1.3)
sec.footer_distance = Cm(1.2)

def set_font(run, name='宋体', size=10.5, bold=False, color=None):
    run.font.name = name
    run.font.size = Pt(size)
    run.bold = bold
    run._element.rPr.rFonts.set(qn('w:eastAsia'), name)
    if color:
        run.font.color.rgb = color

normal = doc.styles['Normal']
normal.font.name = '宋体'
normal.font.size = Pt(10.5)
normal.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
normal.paragraph_format.line_spacing = 1.5
normal.paragraph_format.space_before = Pt(0)
normal.paragraph_format.space_after = Pt(0)

def add_page_field(paragraph, prefix='第 ', suffix=' 页'):
    paragraph.add_run(prefix)
    fld = OxmlElement('w:fldSimple')
    fld.set(qn('w:instr'), 'PAGE')
    t = OxmlElement('w:t')
    t.text = '1'
    fld.append(t)
    paragraph._p.append(fld)
    paragraph.add_run(suffix)

def configure_body_section(s2):
    s2.page_width = Cm(21.0)
    s2.page_height = Cm(29.7)
    s2.top_margin = Cm(2.4)
    s2.bottom_margin = Cm(2.2)
    s2.left_margin = Cm(2.4)
    s2.right_margin = Cm(2.2)
    s2.header_distance = Cm(1.3)
    s2.footer_distance = Cm(1.2)
    # 页码从 1 开始
    pg = OxmlElement('w:pgNumType')
    pg.set(qn('w:start'), '1')
    s2._sectPr.append(pg)
    if s2.header.is_linked_to_previous:
        s2.header.is_linked_to_previous = False
    if s2.footer.is_linked_to_previous:
        s2.footer.is_linked_to_previous = False
    hp = s2.header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = hp.add_run(SW_NAME + ' ' + SW_VER + '　' + DOC_NAME)
    set_font(run, '宋体', 9)
    fp = s2.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_page_field(fp)
    for r in fp.runs:
        set_font(r, '宋体', 9)

# ---------- 写入原语 ----------
def heading(text, level=1, page_break=False):
    if page_break:
        if doc.paragraphs:
            doc.paragraphs[-1].add_run().add_break(WD_BREAK.PAGE)
        else:
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16 if level == 1 else 10)
    p.paragraph_format.space_after = Pt(8 if level == 1 else 4)
    p.paragraph_format.line_spacing = 1.3
    p.paragraph_format.keep_with_next = True
    run = p.add_run(text)
    set_font(run, '黑体', 16 if level == 1 else 12.5, bold=(level == 1))
    return p

def para(text, indent=True, size=10.5, bold=False, space_after=4):
    p = doc.add_paragraph()
    p.paragraph_format.first_line_indent = Pt(21) if indent else Pt(0)
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.line_spacing = 1.5
    run = p.add_run(text)
    set_font(run, '宋体', size, bold=bold)
    return p

def bullets(items):
    for it in items:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Pt(21)
        p.paragraph_format.first_line_indent = Pt(-10)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.line_spacing = 1.4
        run = p.add_run('· ' + it)
        set_font(run, '宋体', 10.5)

def table(headers, rows, widths=None, font_size=9.5):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ''
        p = hdr[i].paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(h)
        set_font(run, '宋体', font_size, bold=True)
        shd = OxmlElement('w:shd')
        shd.set(qn('w:fill'), 'F2F2F2')
        hdr[i]._tc.get_or_add_tcPr().append(shd)
    for row in rows:
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ''
            p = cells[i].paragraphs[0]
            p.paragraph_format.line_spacing = 1.2
            run = p.add_run(str(val))
            set_font(run, '宋体', font_size)
    if widths:
        for r in t.rows:
            for i, w in enumerate(widths):
                r.cells[i].width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t

IMAGES = []
def image(fname, caption, width_cm=14.6):
    path = os.path.join(SHOTS, fname)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(2)
    p.add_run().add_picture(path, width=Cm(width_cm))
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap.paragraph_format.space_after = Pt(8)
    run = cap.add_run(caption)
    set_font(run, '宋体', 9)
    IMAGES.append(fname)

# ---------- 封面（独立分节，无页眉页码） ----------
for _ in range(4):
    doc.add_paragraph()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run(SW_NAME)
set_font(run, '黑体', 26, bold=True)
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(10)
run = p.add_run(SW_VER)
set_font(run, '黑体', 18)
for _ in range(3):
    doc.add_paragraph()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run('软 件 说 明 书')
set_font(run, '黑体', 22, bold=True)
for _ in range(6):
    doc.add_paragraph()
for line in ['文档版本：V1.0', '软件版本：V1.0（构建 0.9.186）', '编制日期：2026 年 11 月']:
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(line)
    set_font(run, '宋体', 12)

# 正文分节
body_sec = doc.add_section(WD_SECTION.NEW_PAGE)
configure_body_section(body_sec)

# ---------- 目录 ----------
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run('目　录')
set_font(run, '黑体', 18, bold=True)
doc.add_paragraph()
TOC = [
    ('第一章  引言', ['1.1 编写目的', '1.2 软件概述', '1.3 术语与缩略语']),
    ('第二章  运行环境', ['2.1 服务端', '2.2 浏览器客户端', '2.3 桌面客户端', '2.4 外部服务依赖']),
    ('第三章  系统架构', ['3.1 总体架构', '3.2 模块划分', '3.3 目录结构', '3.4 关键数据流', '3.5 数据与契约', '3.6 版本与路由']),
    ('第四章  安装与部署', ['4.1 本地开发环境', '4.2 生产部署', '4.3 环境变量', '4.4 首次初始化']),
    ('第五章  账号与会话', ['5.1 注册与登录', '5.2 短信验证码与二次验证', '5.3 会话与权限', '5.4 账号隔离与偏好']),
    ('第六章  创作工作台', ['6.1 工作台总览', '6.2 快捷创作：多智能体会话', '6.3 工作流画布', '6.4 无限画布']),
    ('第七章  作品、评审与交付', ['7.1 作品与版本', '7.2 视觉评审', '7.3 交付与回执', '7.4 模板库与发现']),
    ('第八章  后台管理与运维', ['8.1 账号与邀请', '8.2 模型 Key 池与路由', '8.3 成本、存储与告警', '8.4 运行审计与系统信息']),
    ('第九章  桌面端本地工作区', ['9.1 外壳与加载', '9.2 本地智能体循环', '9.3 工具与审批', '9.4 记忆与压缩']),
    ('第十章  安全设计', ['10.1 身份与凭据', '10.2 请求防护', '10.3 数据与文件安全', '10.4 备份与恢复']),
    ('第十一章  典型使用流程', []),
    ('附录 A  主要接口清单', []),
    ('附录 B  源程序构成统计', []),
    ('附录 C  构建、测试与版本', []),
]
for chapter, subs in TOC:
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(6)
    run = p.add_run(chapter)
    set_font(run, '宋体', 11, bold=True)
    for s in subs:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Pt(21)
        run = p.add_run(s)
        set_font(run, '宋体', 10)
