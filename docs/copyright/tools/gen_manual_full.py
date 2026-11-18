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
# -*- coding: utf-8 -*-
# 正文：第一至第五章

# ============ 第一章 引言 ============
heading('第一章  引言', 1, page_break=True)

heading('1.1 编写目的', 2)
para('本说明书面向软件著作权登记与交付验收，说明 VisionQA 多智能体会话画布创作平台（以下简称“本软件”或“VisionQA”）的功能构成、运行环境、系统架构、操作方式与安全设计，供登记审查人员、使用单位的技术人员与运维人员阅读。')
para('说明书中的功能描述与界面截图均取自软件的真实实现与真实运行界面；版本、接口、数据文件与配置项与交付版本一致。')

heading('1.2 软件概述', 2)
para('VisionQA 是面向内容创作团队的多智能体会话与画布创作平台。它把“找一条可复用的内容结构—拆解它的脚本与分镜—换成自己的产品复刻—评审产出的画面—把成品交付出去并留痕—沉淀成模板”串成一条可执行、可追溯的链路。')
para('软件由三个层次组成：')
bullets([
    '会话层：以“快捷创作”为统一入口，一个输入框内可切换对话、图片、视频三种方式。每个自建智能体有自己的职责说明、知识条目与默认模型；对话按会话保存最近上下文，回复中的结构化草稿可以一键存为模板或送到画布。',
    '画布层：提供两张定位不同的画布。“工作流”是节点编排画布，用输入、大模型、知识库、工具、条件、输出六类节点把一次创作串成可执行流程，由服务端按拓扑序执行并逐节点记录耗时与输出；“无限画布”是自由摆放素材的画布，素材、生成结果与评审笔记在同一张画布上出现，出图出视频在画布上直接发生。',
    '资产层：作品、版本、模板库与交付档案。一条内容对应一件作品，每次修改形成一个版本，评审结论、交付包与回执都挂在具体版本上，事后可逐项追溯。',
])
para('与常见创作工具“帮你想、帮你写、帮你画”的定位不同，VisionQA 把判断放在同等重要的位置：所有评审结论只有“通过 / 需人工确认 / 不通过”三种，并且每条判断都必须指向画面中的具体区域；给不出证据的判断一律降级或写入“无法判断”，不输出没有依据的结论。')

heading('1.3 术语与缩略语', 2)
table(['术语', '含义'], [
    ['智能体', '带职责说明、知识条目与默认模型的对话角色，可创建、编辑、删除，并累计使用次数'],
    ['会话', '一次对话的上下文集合，包含用户消息、智能体回复与结构化草稿'],
    ['画布', '本软件中的两种创作工作面：工作流画布（节点编排）与无限画布（自由摆放素材）'],
    ['节点', '工作流画布上的最小执行单元，类型为输入 / 大模型 / 知识库 / 工具 / 条件 / 输出'],
    ['运行', '一次画布执行，产生逐节点状态、耗时与输出，并记录到运行记录'],
    ['作品', '一条内容的载体，保存绑定的模板、画布与进度，脚本与分镜取自模板'],
    ['版本', '作品的一次可对照状态，记录相对上一版改了什么，可展开为交付包'],
    ['锚点', '评审结论指向的画面区域，用相对坐标表示，前端按比例叠加到图上'],
    ['判定', '评审结论，取值为通过、需人工确认、不通过'],
    ['交付包', '把某一版作品导出为 zip，含清单、现场页、评审对照与帧图，并计算整包 SHA-256'],
    ['契约', '模块之间约定的数据结构与字段，如画布节点类型白名单、评审结果字段'],
    ['SPA', '单页应用，本软件的前端形态，路由由地址栏 hash 决定'],
    ['MCP', '模型上下文协议，本软件通过网关以兼容方式调用外部模型与生成通道'],
])

# ============ 第二章 运行环境 ============
heading('第二章  运行环境', 1, page_break=True)

heading('2.1 服务端', 2)
table(['项目', '要求'], [
    ['操作系统', 'Linux（生产推荐 Debian / Ubuntu Server）或 Windows Server；开发环境支持 Windows 10/11、macOS'],
    ['运行时', 'Node.js 22.12 及以上、25 以下（engines 字段声明 >=22.12.0 <25），使用内置 node:sqlite 模块'],
    ['内存 / 磁盘', '最低 2 vCPU / 2 GiB / 40 GB；常规内容团队建议 4 vCPU / 8 GiB / 100 GB'],
    ['数据库', 'SQLite 单文件数据库（data/auth.db），用于账号、会话、邀请码与审计记录'],
    ['端口', '应用默认监听 127.0.0.1:8799；开发默认 8787；仅监听回环地址，公网访问一律经反向代理'],
    ['反向代理', 'Nginx 终止 TLS 并转发 /api 与 /media；也可使用 Caddy 自动签发证书'],
    ['进程守护', 'systemd 单元 visionqa.service，开机自启、异常自动重启'],
])
para('服务端不需要 GPU：视觉评审与文本生成均通过外部模型接口完成，实测单次评审 60～85 秒、单次对话 20～50 秒，属于接口时延而非本地算力瓶颈。')

heading('2.2 浏览器客户端', 2)
table(['项目', '要求'], [
    ['浏览器', 'Chrome / Edge / Firefox 等现代浏览器，需支持 ES2022、CSS Grid 与 fetch'],
    ['分辨率', '桌面 1280×800 起，主设计宽度 1440；移动端适配 390 宽；平板 768～900 宽可用'],
    ['字体', '拉丁字母使用自托管 Geist 子集（约 52 KB），中文使用系统黑体，页面不请求外部字体服务'],
    ['网络', '需可访问站点域名与模型通道；断网时仅桌面外壳的本地工作区不可用，网页不可用'],
])

heading('2.3 桌面客户端', 2)
table(['项目', '要求'], [
    ['形态', 'Electron 40 外壳，Windows x64；分 NSIS 安装包与免安装单文件两种'],
    ['安装位置', '默认 %LOCALAPPDATA%\\Programs\\VisionQA，按用户安装，不弹 UAC'],
    ['用户数据', '%APPDATA%\\VisionQA Desktop，卸载默认保留，覆盖安装后会话与记忆仍在'],
    ['加载方式', '外壳加载生产站点；本地工作区能力仅在桌面外壳中出现'],
    ['签名与更新', '当前产物未做代码签名，也未接入自动更新；升级通过覆盖安装完成'],
])

heading('2.4 外部服务依赖', 2)
para('以下外部服务均为可选或可降级，未配置时软件照常可用并在界面上如实说明，不伪造结果：')
table(['依赖', '用途', '未配置时的行为'], [
    ['OpenAI 兼容模型接口', '对话、文本生成、逐帧视觉分析', '模型下拉标注“凭证未配置”，选中也不会真正发起调用'],
    ['图片 / 视频生成通道', '无限画布与快捷创作中的出图出视频', '生成按钮不可用，接口返回 503 并给出说明'],
    ['红狐检索接口', '发现页的爆款检索与视频解析', '返回示例数据并在界面明示当前不可用'],
    ['邮件服务（SMTP / DirectMail）', '找回密码、邀请与告警通知', '邮件相关动作提示通道未配置'],
    ['短信服务', '手机号验证码登录与二次验证', '登录页不显示短信入口'],
    ['无限画布服务', '整屏嵌入的外部自由画布', '仅在无限画布页说明未部署，不影响其他功能'],
])

# ============ 第三章 系统架构 ============
heading('第三章  系统架构', 1, page_break=True)

heading('3.1 总体架构', 2)
para('本软件采用前后端分离的单体架构：浏览器加载单页应用，所有数据通过 HTTP 接口读写；服务端为 Node.js 编写的 HTTP 服务，自行维护路由表并按前缀分派到各业务路由模块；数据落在本机 SQLite 与 JSON 文件；模型推理与生成能力通过外部接口调用。')
table(['层次', '组成', '职责'], [
    ['表现层', 'React 19 单页应用、CSS 变量体系、lucide 线性图标', '页面渲染、交互、路由（地址栏 hash）、状态管理'],
    ['接口层', 'server/index.mjs 与 server/routes/*', '会话校验、参数校验、限流、业务编排、统一错误结构'],
    ['领域层', 'server/*.mjs 领域模块', '账号、作品、评审、画布执行、模板、交付、计费、密钥池'],
    ['数据层', 'SQLite（auth.db）、data/*.json、/var/lib/visionqa', '账号与会话、作品与版本、运行记录、模板与交付档案'],
    ['执行层', 'electron/agent/*、worker/video-worker.mjs', '桌面端本地智能体循环、远端抽帧算力参考实现'],
    ['外部通道', '模型接口、生成通道、检索接口、邮件与短信', '推理、出图出视频、素材检索、通知'],
])

heading('3.2 模块划分', 2)
table(['模块', '主要文件', '说明'], [
    ['应用外壳', 'src/main.tsx、src/App.tsx、src/router.ts、src/nav.ts', '挂载应用、地址栏路由解析、侧栏导航的唯一真源'],
    ['工作流画布', 'src/pages/CanvasPage.tsx、src/canvas/*', '节点渲染、连线校验、检查器、运行抽屉、自动布局'],
    ['无限画布', 'src/pages/BoardPage.tsx、server/canvas-session.mjs', '外部画布嵌入、账号互通票据、画布项目与队列视图'],
    ['快捷创作', 'src/pages/AgentsPage.tsx、src/pages/AgentEditorPage.tsx、server/agents.mjs、server/agentChat.mjs', '智能体管理、会话、出图出视频与最近生成'],
    ['作品与版本', 'src/pages/ProjectPage.tsx、src/domain/project.ts、server/projects.mjs', '作品记录、版本对照、脚本快照、分镜画面槽'],
    ['视觉评审', 'src/pages/ReviewPage.tsx、server/review.mjs、server/judge.mjs、server/vision.mjs', '七维评审、判定、锚点、降级与结果留存'],
    ['交付', 'server/delivery-ledger.mjs、server/project-deliverable.mjs、src/pages/ReceiptPage.tsx', '交付包封存、清单与哈希、回执与催收'],
    ['模板与发现', 'server/templates.mjs、server/radar.mjs、src/pages/TemplateLibraryPage.tsx', '模板结构存取、检索、一键复刻'],
    ['账号与会话', 'src/auth/*、server/auth.mjs、server/routes/auth.mjs', '注册登录、口令哈希、会话票据、短信与二次验证'],
    ['后台管理', 'src/pages/admin/*、server/routes/admin.mjs', '账号、密钥池、模型路由、告警、成本、存储与审计'],
    ['本地工作区', 'electron/main.cjs、electron/agent/*', '桌面外壳、本地智能体循环、工具审批、记忆与压缩'],
])

heading('3.3 目录结构', 2)
para('交付源码的顶层目录如下（省略依赖与构建产物）：')
table(['目录 / 文件', '内容'], [
    ['src/', '前端源码：pages（页面）、canvas（工作流画布）、components、domain（领域函数）、api（接口封装）、auth、styles、lib'],
    ['server/', '服务端源码：index.mjs（入口与路由表）、routes/（分业务路由）、领域模块（auth、projects、review、flows、templates、delivery、gateway、keyvault 等）'],
    ['electron/', '桌面端主进程、预加载脚本与本地智能体循环（loop、tools、protocol、memory、compaction、store）'],
    ['worker/', '远端抽帧算力参考实现 video-worker.mjs'],
    ['scripts/', '运维与验收脚本：备份恢复、密钥扫描、负载测试、连通性诊断、安装包图标等'],
    ['test/', '服务端与领域逻辑的自动化测试（node:test）'],
    ['deploy/', '生产部署资产：systemd 单元、Nginx / Caddy 配置、环境变量模板、备份定时器'],
    ['docs/', '设计说明、验收记录、操作手册与截图'],
    ['public/', '静态资源（品牌标识、图标）'],
])

heading('3.4 关键数据流', 2)
para('（1）一次智能体会话：前端把智能体标识、本次输出类型与用户消息提交到 /api/agents/:id/chat；服务端拼接该智能体的职责说明、知识条目与最近 8 条会话记忆，调用模型接口；模型返回后，服务端解析回复中的结构化草稿，落库本次消息并累加使用次数；前端把草稿渲染成卡片，可存为模板或送到画布。')
para('（2）一次画布运行：前端提交节点与连线；服务端按节点类型做白名单归一化，校验连线（禁止自环、每个输入端口只接一根线、禁止成环），按拓扑序逐个执行；每个节点返回状态、耗时与输出，前端在画布上逐个点亮，运行结束后整体写入运行记录，可按节点对照两次运行。')
para('（3）一次视觉评审：前端提交画面与评审意图；服务端优先调用本机视觉评审服务，不可用时退到平台模型并按同一套规则生成结果；返回判定、逐条观察（维度、严重度、锚点、置信度）、有界修正建议与“无法判断”清单，并把实际使用的通道写进结果。')
para('（4）一次交付：把某一版作品的脚本、分镜、帧图、评审对照与现场页打包成 zip，写入清单并计算每条 CRC32 与整包 SHA-256；包内附一页校验页，收包人把包拖进页面即可逐条核对，不需要账号、不上传服务器。')

heading('3.5 数据与契约', 2)
table(['数据', '位置', '说明'], [
    ['账号与会话', 'data/auth.db（SQLite）', '账号、口令哈希、会话哈希、邀请码、审计记录'],
    ['作品与版本', 'data/projects.json 等', '作品记录、版本差异、脚本快照、分镜槽位'],
    ['运行记录', 'data/runs.json', '每次画布运行的逐节点状态、耗时与输出'],
    ['模板库', 'data/templates.json', '模板结构、分镜表、来源链接与互动数据'],
    ['交付档案', 'data/deliveries/ 与作品目录', '交付包、清单、哈希、回执记录'],
    ['上传与帧图', '/var/lib/visionqa 或 data/', '按内容标识分目录存放，接口按标识读取'],
])
para('模块之间的数据结构以字段契约固定：画布节点类型限定为 input、llm、kb、tool、condition、output 六种，旧数据中已移除的类型在加载时丢弃；评审结果的判定取值固定为 pass、needs_review、fail 三种，观察的严重度固定为 blocker、major、minor、info 四级；接口错误统一返回 { error, code } 结构，前端按 code 决定提示文案。')

heading('3.6 版本与路由', 2)
para('前端路由以地址栏 hash 为唯一真源，主要地址包括：#/overview（工作台）、#/projects（作品）、#/projects/<作品id>、#/radar（发现）、#/templates（模板库）、#/agents（快捷创作）、#/canvas（工作流）、#/board（无限画布）、#/review（视觉评审）、#/runs（运行记录）、#/settings（设置）、#/admin/<分区>（后台管理）。旧地址在版本演进中保持可用，必要时由路由层改写到新地址。')
para('软件对外版本为 V1.0，内部构建号随迭代递增（本说明书对应构建 0.9.186）。构建号用于发布与回滚定位，不改变对外版本号。')

# ============ 第四章 安装与部署 ============
heading('第四章  安装与部署', 1, page_break=True)

heading('4.1 本地开发环境', 2)
para('本地运行需要 Node.js 22.12 及以上版本。安装依赖并启动前后端：')
for cmd in [
    'npm ci',
    'npm run dev:api    # 启动接口服务，默认 8787',
    'npm run dev        # 启动前端开发服务器，默认 5173',
    'npm test           # 运行服务端与领域逻辑测试',
    'npm run lint       # 静态检查',
    'npm run build      # 类型检查并构建前端产物',
]:
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Pt(21)
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(cmd)
    set_font(run, 'Consolas', 9.5)

heading('4.2 生产部署', 2)
para('生产环境以 systemd 托管应用进程，Nginx 负责 TLS 与反向代理，应用只监听 127.0.0.1。主要步骤如下：')
bullets([
    '准备服务器与域名，解析 A 记录到服务器地址；',
    '把代码部署到 /opt/visionqa，安装生产依赖并构建前端产物；',
    '按 deploy/env.production.example 写入环境变量，至少打开强制登录与安全 Cookie 两个开关；',
    '安装 systemd 单元 visionqa.service，设置开机自启；',
    '配置 Nginx 站点：80 端口只做证书挑战与跳转，443 终止 TLS 并转发 /api 与 /media；',
    '签发证书并启用备份定时器，每天把数据目录打包到 /var/backups，保留最近 7 份；',
    '访问 /api/health 确认服务、模板库与外部通道状态。',
])
para('发布时保留上一版快照，回滚即恢复上一版目录并重启服务；前端入口文件禁止缓存，静态资源长缓存，避免发版后仍加载旧脚本。')

heading('4.3 环境变量', 2)
para('配置集中在 .env 文件（不入库），主要变量如下：')
table(['变量', '默认值', '作用'], [
    ['VQ_REQUIRE_AUTH', '关闭', '设为 1 后除登录、健康检查与版本接口外全部要求登录'],
    ['VQ_SECURE_COOKIES', '关闭', '设为 1 后会话 Cookie 带 Secure，必须走 HTTPS'],
    ['VQ_REGISTRATION', '关闭', '自助注册开关；关闭时仍可用邀请码开号'],
    ['VQ_SEED_EMAIL / VQ_SEED_PASSWORD', '空', '首次部署的引导账号，建完即从配置中删除'],
    ['VQ_SESSION_DAYS / VQ_REMEMBER_DAYS', '7 / 30', '普通会话与“记住我”会话的有效天数'],
    ['VISION_BASE_URL / VISION_API_KEY', '空', 'OpenAI 兼容模型接口地址与密钥'],
    ['LLM_MODEL / VISION_MODEL', '空', '文本模型与视觉模型标识，可配置降级链'],
    ['VQ_GATEWAY_TOKEN', '空', '生成通道令牌；未配置时生成接口整体返回 503'],
    ['VQ_GATEWAY_OPEN', '0', '生成能力开关，上游额度未开通时保持关闭'],
    ['VQ_CREDIT_*', '100 / 2 / 10 / 5 / 1 / 2', '初始积分与检索、复刻、评审、对话、画布运行单价'],
    ['REDFOX_API_KEY', '空', '发现页检索与视频解析的第三方密钥'],
    ['REPLICATE_REMOTE_URL', '空', '把抽帧交给远端算力；配置后本机不再运行 FFmpeg'],
])

heading('4.4 首次初始化', 2)
para('首次部署后按以下顺序初始化：写入引导账号并启动服务，用该账号登录；在设置页修改口令；在后台“账号”中创建团队成员账号或签发邀请码；在后台“模型 Key”中录入模型与生成通道密钥；在“模型与上游”中确认模型目录与单价；在“系统”中核对版本、存储与依赖状态。')
para('账号口令只以哈希形式保存，管理员也无法读回明文；成员忘记口令时由管理员重置或通过邮件找回（需配置邮件通道）。')

# ============ 第五章 账号与会话 ============
heading('第五章  账号与会话', 1, page_break=True)

heading('5.1 注册与登录', 2)
para('软件提供邮箱口令登录、手机号验证码登录与邀请码注册三种入口。自助注册默认关闭，只有管理员显式打开或签发邀请码后，新用户才能自行创建账号。')
para('登录成功后，服务端签发随机会话票据，通过 HttpOnly、SameSite=Lax 的 Cookie 下发，浏览器脚本读不到票据；页面刷新时先用本地缓存渲染，再向服务端校验身份，校验失败才回到登录页。登录失败统一提示“邮箱或密码不正确”，不区分邮箱是否存在。')
para('“记住我”把会话有效期延长到 30 天；未勾选时为 7 天。退出登录会清除服务端会话记录与浏览器 Cookie，旧票据立即失效。')

heading('5.2 短信验证码与二次验证', 2)
para('手机号登录通过短信通道下发 6 位验证码，验证码有有效期与尝试次数限制，同一号码与来源地址都有频次限制。后台可以查看最近发码记录，包含时间、掩码手机号、通道返回结果与失败原因，发码失败不会只让用户知道。')
para('敏感操作（如管理员登录、修改身份信息）可要求二次验证；二次验证的开关与有效期由后台配置。')

heading('5.3 会话与权限', 2)
para('系统区分普通成员与管理员两类身份。普通成员只能访问自己的作品、模板、运行记录、生成任务与积分流水；管理员进入后台管理版（地址栏加 ?edition=admin），可查看全站数据、发放积分、管理模型 Key 与通道，并可一键返回生产版。后台的每个数据卡片都标注来源（真实接口或本地会话），没有接口的数字直接显示为“—”，不用估算值充数。')

heading('5.4 账号隔离与偏好', 2)
para('所有按账号归属的数据在服务端按账号标识过滤：模板、作品、工作流、运行记录、上传图片、生成任务、积分与偏好均带归属校验，越权访问返回拒绝而不是空列表。项目内有一组账号隔离矩阵测试覆盖这些路径。')
para('用户偏好（列表筛选、排序、每页条数、上次访问的分区等）保存在服务端，换设备登录后仍然生效；界面缩放、侧栏折叠等纯本机状态保存在浏览器本地。')

# -*- coding: utf-8 -*-
# 正文：第六章至第十一章与附录

# ============ 第六章 创作工作台 ============
heading('第六章  创作工作台', 1, page_break=True)

heading('6.1 工作台总览', 2)
para('登录后的第一个页面是工作台。它不展示统计报表，只回答“下一步点哪里”：顶部卡片给出最近一件作品与它的下一步动作（继续改、送评审、去交付），下面依次是“评审等你看的”“交出去的”“最近运行”与“模板库”。')
para('“交出去的”把每一次交付摊成一条线：哪件作品的哪一版、什么时候交的、交时评审结论、现在还作不作数；封过包的每一条带回收据结论（对得上、对不上、对方读不出来、还没收到），对不上的另起一句说明差在哪一项。点任意一行直接落到作品页那一版的交付档案上。')
para('三个入口卡片把常见起点摆在同一行：从爆款开始（按关键词检索并加入模板库）、从模板开始（套用已解析的模板）、空白画布（从零搭节点、跑一次看每个节点返回什么）。')
image('04-workbench.png', '图 6-1  工作台：下一步、评审、交付与最近运行', width_cm=11.2)

heading('6.2 快捷创作：多智能体会话', 2)
para('“快捷创作”是会话层的统一入口。页面顶部只有一个输入框，旁边三个方式页签：对话、图片、视频。选“对话”时，输入框下面是智能体、输出类型与模型三个参数；选“图片”或“视频”时，参数行原地变成生成表单（提示词、比例、时长、分辨率与本次消耗积分），发送后结果落在页面下方，不再弹独立窗口。')
para('每个自建智能体有名称、职责说明、分类（内容复刻、视觉评审、脚本分镜、投放素材）、知识条目与默认模型，卡片上显示使用次数与最近运行时间，可编辑、删除或新建。发送后进入对话视图：用户消息靠右、智能体消息靠左，运行中显示计时，失败显示模型标识、状态码与原因，可原样重试。')
para('对话记忆由服务端截断：每次带上最近 8 条消息、总计不超过 6000 字，超出部分不进入上下文。回复中的结构化草稿只认回复里那段约定格式的 JSON，解析成功后出现“存为模板”与“送到画布”两个出口；模型没有给出草稿时不从正文反推，避免把猜测当成数据。')
para('图片与视频生成按条扣积分，失败全额退回；生成记录保留最近若干条并支持往回翻页，关掉表单再回来也能找回上一条并下载。视频生成会按上游接口要求传入比例（9:16、16:9、1:1），上游拒绝时把真实原因写进失败信息。')
image('07-agents-chat.png', '图 6-2  快捷创作：一个输入框内切换对话、图片、视频', width_cm=14.6)
image('08-agents-image.png', '图 6-3  出图：参数在输入框内展开，结果落在下方', width_cm=14.6)

heading('6.3 工作流画布', 2)
para('工作流画布用于把一次创作拆成可复用、可复跑的步骤。画布中间是节点，右侧是节点检查器，节点面板默认收起，双击画布空白处或点“节点”按钮才唤出，避免一进页面就被一列按钮占掉焦点。')
para('节点只有六类，每类有自己的输入端口与输出端口：')
table(['节点', '作用', '端口'], [
    ['输入', '把文本或素材说明送进流程', '输出 out'],
    ['大模型', '拼接提示词与上游上下文，调用模型生成内容', '输入 prompt / context，输出 out'],
    ['知识库', '按关键词与内容类型读取模板库，作为下游上下文', '输入 query（可选），输出 out'],
    ['工具', '执行服务端注册的内置工具，如模板库统计、当前时间', '输入 arg（可选），输出 out'],
    ['条件', '按表达式判断走 true 还是 false 分支', '输入 in，输出 true / false'],
    ['输出', '汇总上游文本，形成本次运行的产物', '输入 in'],
])
para('连线有四条校验：不能把节点连到自己；同一对端口不能重复连接；每个输入端口只接一根线；连线不能形成环路。校验不通过时立即给出中文原因，不会悄悄接受一条跑不起来的线。画布还提供自动布局（按最长路径分列、同列纵向居中）、撤销与重做、适应工作流，节点参数在检查器中修改并即时保存到画布数据。')
para('点“运行流程”后，服务端按拓扑序执行：大模型节点调用模型，知识库节点读取模板库，条件节点按表达式分支，输出节点汇总结果。每个节点返回状态、耗时与输出，节点在画布上逐个点亮，右侧运行抽屉同步显示每个节点的输入输出；运行整体写入运行记录，可按节点对照同一张画布或同件作品另一版画布的两次运行，输出差异按需展开。')
image('05-workflow.png', '图 6-4  工作流画布：节点编排、检查器与运行入口', width_cm=14.6)

heading('6.4 无限画布', 2, page_break=True)
para('无限画布是自由摆放素材的工作面：图片、视频、文本笔记与生成结果都作为节点出现在同一张画布上，可以随意拖动、缩放、连线。它是第三方画布服务，本软件以整屏嵌入的方式接入，上方保留一条 42 像素高的状态条，提供画布项目下拉、新建画布、写笔记、专注模式与新窗口打开。')
para('两块画布在导航中分开：工作流是节点编排，无限画布是素材与生成。两者互不替代，用户不会再在“内置编排”与“外部画布”之间迷失。')
para('本软件与无限画布之间有一套账号互通机制：本软件是唯一身份源，用户点击进入时服务端签发一张短时票据（HS256 签名的 JWT，默认 120 秒有效，带签发方、受众、用户标识与一次性编号，不落库、不可复用），无限画布用同一把共享密钥校验后换出自己的会话与影子用户。未配置共享密钥时整体关闭，无限画布仍走它自己的登录，不会误开免登录入口。')
para('在画布内出图出视频时，本软件提供排队位视图：只回聚合数（在跑几条、在等几条、最久的等了多久），不返回票号、不扣积分、不调上游；画布页轮询它来显示“前面还有几条”。生成结果按积分计价，余额与充值仍在工作台的设置页完成。')
image('06-board.png', '图 6-5  无限画布：状态条、画布项目与画布内容', width_cm=13.4)

# ============ 第七章 作品、评审与交付 ============
heading('第七章  作品、评审与交付', 1, page_break=True)

heading('7.1 作品与版本', 2)
para('作品是一条内容的载体：一条内容一条记录，保存“绑定哪条模板、哪块画布、走到哪一步”，脚本与分镜实时取自模板，避免同一份内容在多个地方各存一份而互相矛盾。作品页按下一步给出一张主卡：开画布、送评审、继续改或去交付。')
para('每次修改形成一个版本。版本页写清这一版相对上一版改了什么，任意两版可逐项查看节点参数的前后值；两版的评审结论、按严重度统计的问题数、交付状态与交时评审并排展示。交付后重新评审会单独记一条，不改写交付时的结论。旧版脚本快照可点开查看，归档版可以以这一版为底再开一版。')
para('分镜中的每一镜有自己的画面槽：可以把生成的图贴到某一镜、换一张或退回原片帧，评审页可以直接挑这一镜去评，模板本身不动。每一镜还带一条由画面、机位与脚本拼成的出图提示词，可复制单镜或整条，不调模型、不消耗积分。')
image('10-project.png', '图 7-1  作品页：主卡、版本与分镜', width_cm=14.6)

heading('7.2 视觉评审', 2)
para('视觉评审是软件的判断核心。进入评审页后先在左侧选一张画面：可以粘贴本版要发的截图，也可以挑模板首帧、作品某一镜的画面；右侧给出结论与证据。')
para('评审按七个视觉维度进行：层级、对比、间距、字体、色彩、构图、可识别性。输出包含四部分：判定（通过 / 需人工确认 / 不通过）、逐条观察（维度、严重度、判断语句、像素锚点、置信度）、有界修正建议、以及“无法判断”清单（例如看不到动效时序、未提供投放尺寸）。只有阻断级与主要级问题才计入“需人工确认”或“不通过”的理由；没有锚点的观察降级为信息级，并明确标注“无锚点”。')
para('评审优先调用本机视觉评审服务，服务不可达时退回平台模型并按同一套规则生成结果，返回中用通道字段写清本次由谁给出结论，绝不把本地模型结果冒充成专用评审服务的结果；两条通道都不可用时返回“需人工确认”并说明没有可用通道，不伪造判断。评审结果可按作品留存，形成历史记录，可从作品页直接回到某一条评审。')
image('09-review.png', '图 7-2  视觉评审：选画面、出结论、给证据', width_cm=14.6)

heading('7.3 交付与回执', 2)
para('标记交付时，软件把这一版作品的脚本、分镜、帧图、现场页与评审对照打包成 zip，当场封存；开新版或改模板之后，旧版仍能原样下载。交付档案可展开包内清单、复制整包 SHA-256，下载后拖回同一块界面即可在本机核对；服务器上那一份也能点“查一遍哈希”重算，丢失、大小变化或内容被替换都会直接说明。')
para('包内附一页校验页：收包人把 zip 拖进页面就逐条核对 CRC32 并算出整包 SHA-256，不上传、不联网、不要账号；核对完可生成一段收据（谁、哪一份、结论、整包哈希、时间、坏在哪），复制或存成文本发回。收据贴回作品页的交付档案就能与封存包比对（版次、包名、字节、整包哈希、对方结论五项），结论记在那一条交付记录上。')
para('交付链接可以设置称呼（给谁的），工作台按称呼生成提醒话术；链接打开会记一次打开（只存哈希前缀、只分四类客户端），未打开的可以重发或更换链接，更换有次数上限，旧地址会明确告知“已经换成新的”。')

heading('7.4 模板库与发现', 2)
para('“发现”页按平台、关键词与时间范围检索内容，卡片给出播放、点赞、收藏、评论、转发与互动率；取不到的指标隐藏，不做估算。检索需要用户点“检索”才发起请求，进页面不会自动消耗额度。')
para('“一键复刻”把一条内容拆成五步并实时显示进度与日志：解析视频地址、读取视频信息（探测时长与场景切点）、按场景抽帧、逐帧分析脚本与分镜、写入模板库。抽帧可以在本机完成，也可以配置远端算力地址后整体交给远端，服务端不再需要运行视频处理工具。')
para('模板库只保存原链接、互动数据与解析出的脚本结构（钩子、节拍、口播、屏幕字）与分镜表（画面、机位、字幕、声音、叙事作用与对应帧图），不保存视频文件本身。模板分待解析与已解析两种状态，详情里可“去解析”“送去评审”或“用这条开始创作”。')
para('智能体回复中的结构化草稿可以存为模板，也可以直接送到画布成为节点，形成“会话产出—模板沉淀—画布执行”的闭环。')

# ============ 第八章 后台管理与运维 ============
heading('第八章  后台管理与运维', 1, page_break=True)

heading('8.1 账号与邀请', 2)
para('后台“账号”页列出账号的显示名、邮箱、登录手机号、身份、积分与最近登录，可修改账号身份信息、重置口令、禁用账号，改动记入操作日志。邀请码页可签发、撤销邀请码，设置赠送积分、有效期与可用次数；邀请码只在创建时显示一次明文，之后只保存哈希。')

heading('8.2 模型 Key 池与路由', 2)
para('后台“模型 Key”管理上游密钥池：支持多把密钥、权重与优先级、启用状态、最近探测结果与冷却状态。密钥以加密形式保存，界面只显示掩码；密钥被上游限流或拒绝时进入冷却，界面写明“上游刚失败，冷却 N 秒后再试”，不再误报为“请补一把 Key”。')
para('“模型与上游”页按平台列出模型目录（能力、平台来源、上游单价、接入状态），一个模型同时出现在两个平台时并排显示两条来源与价格；没有启用密钥时明确标注“仅参考”，不把目录当成可用能力。模型路由可按文本、图片、视频分别指定平台与模型，并支持降级链。')
image('11-admin.png', '图 8-1  后台管理版：模型与上游、模型目录与接入状态', width_cm=14.6)

heading('8.3 成本、存储与告警', 2)
para('“成本”与“计费”页给出积分口径、消耗明细与订单；积分口径只有一处配置（默认 1 元 = 10 积分），充值页、默认档位与画布报价都读同一处，避免多套价格并存。')
para('“存储守护”监控数据目录与上传目录的占用，接近阈值时给出清理建议并阻止继续写入；“告警”按未确认、已确认、全部三种视图展示通道异常、上游失败、备份失败等事件，确认不是删除，可撤回确认。告警可配置 Webhook 与邮件通道，通道不可用时事件仍然留在列表里。')

heading('8.4 运行审计与系统信息', 2)
para('“运行审计”按时间倒序列出每次画布运行，可展开逐节点输出与耗时，支持按账号与画布筛选。“系统”页显示版本、启动时间、运行时版本、数据库大小、备份状态与无限画布三个服务的连通性，便于判断“是站点的问题还是依赖的问题”。')
para('后台与生产版共用同一个登录会话，管理员从后台一键返回生产版；后台入口不出现在生产版导航里，只能通过地址栏参数进入。')

# ============ 第九章 桌面端本地工作区 ============
heading('第九章  桌面端本地工作区', 1, page_break=True)

heading('9.1 外壳与加载', 2)
para('桌面端由 Electron 外壳加载生产站点，网页本体不随客户端打包：界面与接口始终与线上一致，客户端只提供本机能力。外壳提供窗口控制、站点加载失败的说明页、以及只在桌面端出现的“本地工作区”入口。')

heading('9.2 本地智能体循环', 2)
para('本地工作区让智能体在本机读写文件、执行命令。每个用户选择或新建一个工作区目录后，可以在会话里描述任务；一轮对话等于若干步“模型决定→本地执行→结果回到上下文”的循环，默认最多 8 步，单次工具输出超过 8000 字截断。模型补全走账号会话由服务端代理，密钥不下发到客户端。')
para('循环本身不依赖界面：模型调用、事件输出与审批函数都由外部注入，因此测试可以在不开窗口的情况下完整跑一轮，包含工具调用、拒绝与上下文压缩。')

heading('9.3 工具与审批', 2)
para('本地工具共六个：列目录、读文件、按通配符搜索内容、写文件、编辑文件、执行命令。其中写文件、编辑文件与执行命令属于有副作用的操作，必须由用户逐次批准；只读工具不需要批准。所有路径都被限制在工作区根目录内，越界的路径直接拒绝，审批是第二道门而不是唯一一道。')
para('命令执行有 60 秒超时与输出上限，超时会被终止并在结果里写明；搜索会跳过依赖、构建产物与版本库目录，避免把命中挤满。')

heading('9.4 记忆与压缩', 2)
para('会话按工作区落盘，可随时续上；每轮开始前按用户刚说的话从长期记忆里召回相关条目，只放进系统提示，不改动会话历史，记忆读写失败不影响本轮继续。上下文超出预算时，先把较早的消息压成摘要并保留摘要头，摘要失败就保持原样、下一轮再试，宁可重试也不悄悄丢掉历史。')
para('长期记忆按工作区隔离，可在界面中查看与删除；它只存在于本机，不随网页端同步。')

# ============ 第十章 安全设计 ============
heading('第十章  安全设计', 1, page_break=True)

heading('10.1 身份与凭据', 2)
para('口令使用 scrypt（N=16384、r=8、p=1）加每用户随机盐存哈希，数据库中不存在明文口令；会话是 32 字节随机票据，库中只存其 SHA-256，明文只出现在 HttpOnly Cookie 中，浏览器脚本读不到。上游密钥在保存前加密，界面只显示掩码。')
para('系统不通过响应时间泄露账号是否存在：邮箱不存在时同样执行一次口令校验；登录失败统一提示，不区分邮箱错误与口令错误。')

heading('10.2 请求防护', 2)
para('写请求校验来源：带 Origin 且与 Host 不一致的请求直接拒绝，挡最省事的跨站请求伪造；登录按“来源地址 + 账号”做滑动窗口限流（10 分钟 8 次失败即锁定）；上传限制类型与大小，并按内容标识隔离存放；对外部地址的读取有超时与协议限制，避免被利用做内网探测。')

heading('10.3 数据与文件安全', 2)
para('按账号归属过滤是数据访问的默认行为：查询在服务端拼接归属条件，越权返回拒绝；交付包在生成时写入逐条 CRC32 与整包 SHA-256，之后可随时重算比对；包内校验页在浏览器本地完成核对，不上传文件。桌面端工具限制在工作区内，写文件与执行命令需逐次审批。')

heading('10.4 备份与恢复', 2)
para('数据目录每天定时打包到备份目录，保留 7 份，备份包含数据库的预写日志，恢复时由数据库自行重放。备份文件带校验信息，恢复脚本先校验再解包，恢复后执行一次完整性检查并对照关键表行数；备份失败会进入告警列表，不会静默失败。')

# ============ 第十一章 典型使用流程 ============
heading('第十一章  典型使用流程', 1, page_break=True)
para('以一条新的内容为例，从检索到交付的完整路径如下：')
steps = [
    '在工作台选择“从爆款开始”，在发现页输入关键词并点“检索”，挑一条结构合适的内容；',
    '点“一键复刻”，等待五个步骤跑完，模板库出现一条已解析模板，含脚本结构与分镜表；',
    '打开模板详情，点“用这条开始创作”，建立作品并绑定模板；',
    '在作品页编辑脚本与分镜，每一镜可以贴图或生成新画面；需要大改时点“以这一版为底”开新版本；',
    '把这一版送进“视觉评审”，看判定、逐条观察与锚点，按有界修正建议改画面后重评；',
    '需要重复的步骤搬到“工作流画布”，用六个节点连成一条线，运行一次核对每个节点的输出；',
    '需要自由摆放素材与即时出图出视频时，打开“无限画布”，在画布上生成并把结果拖回作品；',
    '评审通过后点“标记交付”，封存交付包、复制哈希或链接发给对方，等待回执在交付档案里对上；',
    '把这次的结构存为模板或从会话草稿生成模板，作为下一次创作的起点。',
]
for i, s in enumerate(steps, 1):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Pt(21)
    p.paragraph_format.first_line_indent = Pt(-14)
    p.paragraph_format.space_after = Pt(4)
    run = p.add_run('%d. ' % i + s)
    set_font(run, '宋体', 10.5)
para('整个过程中，每一步的结果都能回到上一处：评审结论挂在作品版本上，交付包挂在版本上，运行记录可按节点对照，模板可以继续被下一条内容复用。')

# ============ 附录 A 接口 ============
heading('附录 A  主要接口清单', 1, page_break=True)
table(['方法与路径', '说明'], [
    ['GET /api/health', '服务、模板库与外部依赖的可用性'],
    ['GET /api/auth/config', '注册开关、口令策略与登录方式'],
    ['POST /api/auth/login / register / logout', '登录、注册与退出'],
    ['GET /api/auth/me', '当前会话用户'],
    ['POST /api/auth/sms/*', '短信验证码下发与校验'],
    ['GET/POST /api/projects、/api/projects/:id', '作品列表、创建、详情与更新'],
    ['GET/POST /api/projects/:id/versions', '作品版本列表与新建版本'],
    ['GET/POST /api/flows、/api/flows/:id/run', '工作流存取与运行'],
    ['GET /api/runs', '运行记录与逐节点结果'],
    ['GET/POST /api/agents、POST /api/agents/:id/chat', '智能体管理与会话'],
    ['GET/POST /api/media-gen、GET /api/media-gen/recent', '出图出视频与最近生成'],
    ['POST /api/review', '视觉评审（返回判定、观察、锚点与修正建议）'],
    ['GET/POST /api/templates、/api/templates/:id/reuse', '模板库与套用'],
    ['GET/POST /api/reviews、/api/reviews/:id', '评审记录'],
    ['POST /api/deliveries、GET /api/receipt/:token', '交付封存与回执页'],
    ['GET /api/canvas/session-token', '签发无限画布互通票据'],
    ['GET /api/canvas/queue', '无限画布生成排队位（只读聚合）'],
    ['GET/POST /api/admin/*', '后台管理：账号、邀请、密钥、模型、告警、成本、存储、审计'],
    ['GET /media/frames/:id/:file', '抽帧与生成结果静态读取'],
])

# ============ 附录 B 统计 ============
heading('附录 B  源程序构成统计', 1, page_break=True)
para('交付源程序共 323 个代码文件、84,873 行，其中非空行 79,754 行。按目录统计如下：')
stats = [
    ['src/pages', '46', '28,378'],
    ['server（含 routes）', '156', '38,536'],
    ['src/domain、src/components、src/api', '86', '12,224'],
    ['src/canvas、src/auth、src/lib、src/desktop 等', '17', '3,671'],
    ['electron（外壳与本地智能体）', '10', '1,599'],
    ['worker', '1', '112'],
]
table(['目录', '文件数', '行数'], stats, widths=[6.0, 3.0, 3.0])
para('源程序文档按“入口—路由—画布—会话—评审—服务端—桌面端”的顺序连续编排，前 30 页为源程序开头部分，后 30 页为末尾部分，中间省略部分以说明行标注。')

# ============ 附录 C ============
heading('附录 C  构建、测试与版本', 1, page_break=True)
table(['项目', '值'], [
    ['软件名称', 'VisionQA 多智能体会话画布创作平台'],
    ['对外版本', 'V1.0'],
    ['内部构建号', '0.9.186'],
    ['开发语言', 'TypeScript、JavaScript（Node.js）、CSS'],
    ['前端框架', 'React 19.3、Vite 8.3、@xyflow/react 12.12'],
    ['桌面框架', 'Electron 40.10、electron-builder 26.18'],
    ['测试', 'node:test 自动化测试，覆盖账号、作品、评审、画布、交付、计费等模块'],
    ['静态检查', 'oxlint、TypeScript 编译检查'],
    ['构建命令', 'npm run build（类型检查 + 前端构建）、npm run desktop:dist（桌面安装包）'],
])
para('本说明书所述功能与截图对应构建 0.9.186；后续内部构建号变化不影响对外版本 V1.0 的功能范围。')

doc.save(os.path.join(OUT, '02_软件说明书_%s_%s.docx' % (SW_NAME.replace(' ', ''), SW_VER)))
print('saved manual, images:', len(IMAGES), IMAGES)
