# r343 独立取证 #3/#5 + lead 追加（d）：真实渲染的普通用户界面 0 厂牌/内部型号、390×844 无横向溢出。
#
# 做法：本地假上游（Python http.server，0 真实上游调用）+ 真起 node 服务（临时 DATA_DIR）
# + vite dev 编译当前 src（不是 dist 旧产物）+ Playwright Chromium 真渲染。
# 扫「可见文字 + title/aria-label/placeholder/alt + 输入框 value」，逐屏断言。
#
# 用法（用 DSH 自带 Python，带 playwright）：
#   <python> scripts/verify-r343-ui.py
# 退出码：0 全过；1 有 FAIL。
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, '.tmp-r343-verify')
SHOTS = os.path.join(WORK, 'shots')
os.makedirs(SHOTS, exist_ok=True)

AT = chr(64)
USER_EMAIL = 'verify-user-r343' + AT + 'verify.test'
ADMIN_EMAIL = 'verify-admin-r343' + AT + 'verify.test'
PASSWORD = 'Passw0rd!demo'
KEY_SECRET = 'verify-r343-secret'

PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    '0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082'
)

VENDOR = re.compile(
    r'deepseek|geteapi|seeapi|cgcm|openai|claude|anthropic|gemini|qwen|doubao|火山|moonshot|'
    r'zhipu|minimax|grok|sora|midjourney|seedream|kling|hunyuan|ernie|codex|workbuddy',
    re.IGNORECASE,
)
MODELISH = re.compile(r'[a-z0-9]-(flash|pro|turbo|luna|mini|max)\b', re.IGNORECASE)

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), str(detail)))
    print(('[PASS] ' if ok else '[FAIL] ') + name + (' :: ' + str(detail) if detail else ''))
    return bool(ok)


def hits(text, pattern=VENDOR):
    found = []
    for match in pattern.finditer(text):
        start = max(0, match.start() - 24)
        end = min(len(text), match.end() + 24)
        found.append({'token': match.group(0), 'context': text[start:end].replace('\n', ' ')})
    return found


def free_port():
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


# ── 假上游 ────────────────────────────────────────────────────────────────
FAKE_REQUESTS = []


class FakeHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        text = raw.decode('utf-8', 'replace')
        entry = {
            'method': 'POST',
            'url': self.path,
            'contentType': self.headers.get('Content-Type', ''),
            'body': text,
        }
        FAKE_REQUESTS.append(entry)
        print('[fake] POST ' + self.path + ' bytes=' + str(len(raw)))
        if self.path.endswith('/chat/completions'):
            try:
                data = json.loads(text or '{}')
            except Exception:
                data = {}
            reply = '收到，这一步就这样做。'
            if data.get('stream'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Connection', 'close')
                self.end_headers()
                chunk = 'data: ' + json.dumps({'choices': [{'delta': {'content': reply}}]}) + '\n\n'
                self.wfile.write(chunk.encode('utf-8'))
                chunk = 'data: ' + json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]}) + '\n\n'
                self.wfile.write(chunk.encode('utf-8'))
                self.wfile.write(b'data: [DONE]\n\n')
                return
            self._json(200, {
                'model': data.get('model') or 'fake',
                'choices': [{'message': {'role': 'assistant', 'content': reply}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 11, 'completion_tokens': 7},
            })
            return
        if re.search(r'/images/(generations|edits)$', self.path):
            self._json(200, {'created': 1, 'data': [{'b64_json': 'data:image/png;base64,' + base64.b64encode(PNG).decode()}]})
            return
        if self.path.endswith('/video/generations'):
            self._json(200, {'id': 'fake_video_1', 'status': 'queued'})
            return
        self._json(404, {'error': {'code': 'FAKE_NOT_FOUND'}})


def start_fake():
    server = ThreadingHTTPServer(('127.0.0.1', 0), FakeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, 'http://127.0.0.1:' + str(server.server_address[1])


# ── 进程与 HTTP ───────────────────────────────────────────────────────────
CHILDREN = []


def spawn(args, env=None):
    child = subprocess.Popen(
        args,
        cwd=ROOT,
        env={**os.environ, **(env or {})},
        stdout=open(os.path.join(WORK, 'ui-' + str(len(CHILDREN)) + '.log'), 'wb'),
        stderr=subprocess.STDOUT,
    )
    CHILDREN.append(child)
    return child


def kill_tree(proc):
    try:
        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def wait_http(url, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status < 500:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def node_run(args, env=None):
    return subprocess.run(
        ['node', '--experimental-sqlite'] + args,
        cwd=ROOT,
        env={**os.environ, **(env or {})},
        capture_output=True,
        text=True,
        timeout=120,
    )


SEED_ENV = {'DATA_DIR': '', 'VQ_KEY_SECRET': KEY_SECRET, 'VQ_CREDIT_WELCOME': '300', 'VQ_REQUIRE_AUTH': '1'}


def seed_action(action, data_dir, extra):
    env = dict(SEED_ENV)
    env['DATA_DIR'] = data_dir
    return node_run([os.path.join(ROOT, 'scripts', 'verify-r343-seed.mjs'), action, data_dir, extra], env)


# ── 页面扫描 ──────────────────────────────────────────────────────────────
SCAN_JS = r"""
() => {
  const out = [];
  const add = (value) => {
    const text = String(value || '').trim();
    if (text) out.push(text);
  };
  add(document.title);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!el) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    add(node.nodeValue);
  }
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) {
    for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) add(el.getAttribute(attr));
  }
  for (const el of document.querySelectorAll('input,textarea,select')) {
    add(el.value);
    if (el.tagName === 'SELECT') {
      const option = el.options[el.selectedIndex];
      if (option) add(option.textContent);
    }
  }
  return out.join(String.fromCharCode(10));
}
"""


def scan(page):
    try:
        return page.evaluate(SCAN_JS)
    except Exception as error:
        return '（扫描失败：' + str(error) + '）'


def route_url(base, route):
    return base + '/#' + route


def click_first(page, selector, timeout=8000):
    """先正常点；被遮挡时退回强制点 / 直接派发 click（取证只关心「点开之后是什么」）。"""
    try:
        page.click(selector, timeout=timeout)
        return True
    except Exception:
        pass
    try:
        page.locator(selector).first.click(force=True, timeout=3000)
        return True
    except Exception:
        pass
    try:
        page.locator(selector).first.dispatch_event('click')
        return True
    except Exception as error:
        print('[click] ' + selector + ' 失败：' + str(error)[:160])
        return False


def dismiss_guide(page):
    """首访的「欢迎使用 VisionQA」上手引导会盖住整页：关掉它再量，否则量到的是弹窗。"""
    try:
        button = page.locator('button[aria-label="关闭引导"]')
        if button.count() and button.first.is_visible():
            button.first.click(force=True, timeout=3000)
            page.wait_for_timeout(400)
            return True
    except Exception:
        pass
    return False


def goto(page, url, wait=1500):
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=120000)
    except Exception as error:
        print('[nav] ' + url + ' ' + str(error)[:200])
    page.wait_for_timeout(wait)
    dismiss_guide(page)
    return page


def main():
    fake_server, fake_origin = start_fake()
    print('[fake] ' + fake_origin)

    data_dir = os.path.join(WORK, 'data-ui')
    shutil.rmtree(data_dir, ignore_errors=True)
    os.makedirs(data_dir, exist_ok=True)
    seeded = seed_action('seed', data_dir, fake_origin)
    if seeded.returncode != 0:
        print(seeded.stdout)
        print(seeded.stderr)
        sys.exit(1)
    print('[seed] ok')
    # 注册后引导要收尾：否则每个账号第一次进来都被「先确认你在做什么」弹窗挡住，
    # 界面取证量到的就只有弹窗，等于什么都没验。
    for who in (USER_EMAIL, ADMIN_EMAIL):
        done = seed_action('onboard', data_dir, who)
        if done.returncode != 0:
            print(done.stdout)
            print(done.stderr)
            sys.exit(1)
    print('[onboard] done')

    user_token = json.loads(seed_action('token', data_dir, USER_EMAIL).stdout)['token']
    admin_token = json.loads(seed_action('token', data_dir, ADMIN_EMAIL).stdout)['token']

    api_port = free_port()
    vite_port = free_port()
    api = spawn(
        ['node', '--experimental-sqlite', os.path.join(ROOT, 'server', 'index.mjs')],
        {
            'DATA_DIR': data_dir,
            'VQ_KEY_SECRET': KEY_SECRET,
            'VQ_CREDIT_WELCOME': '300',
            'VQ_REQUIRE_AUTH': '1',
            'VQ_UI_MODE': 'prod',
            'VISION_BASE_URL': fake_origin + '/v1',
            'VISION_API_KEY': 'sk-verify-fake-1234567890',
            'VISION_MODEL': 'deepseek-flash',
            'VISION_FALLBACKS': '',
            'LLM_MODEL': 'deepseek-flash',
            'LLM_FALLBACKS': '',
            'API_PORT': str(api_port),
        },
    )
    api_base = 'http://127.0.0.1:' + str(api_port)
    if not wait_http(api_base + '/api/health'):
        print('[fatal] 临时 API 没起来')
        sys.exit(1)
    print('[api] ' + api_base)

    vite = spawn(
        ['node', os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', str(vite_port), '--strictPort'],
        {'API_TARGET': api_base},
    )
    vq_base = 'http://127.0.0.1:' + str(vite_port)
    if not wait_http(vq_base + '/', 120):
        print('[fatal] vite dev 没起来')
        sys.exit(1)
    # 先预热一次：vite 第一次编译（依赖预打包）可能要一两分钟，别让第一次导航等超时
    try:
        urllib.request.urlopen(vq_base + '/src/main.tsx', timeout=180).read()
    except Exception as error:
        print('[vite] 预热失败（继续）：' + str(error)[:160])
    time.sleep(3)
    print('[vite] ' + vq_base)

    exit_code = 0
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()

            def new_page(cookie_token, viewport=None, block_external=False):
                context = browser.new_context(viewport=viewport or {'width': 1440, 'height': 900}, device_scale_factor=1)
                context.add_cookies([{'name': 'vq_session', 'value': cookie_token, 'url': vq_base}])
                if block_external:
                    def handler(route):
                        url = route.request.url
                        if not url.startswith('http://127.0.0.1') and not url.startswith('ws://127.0.0.1'):
                            route.fulfill(status=204, body='')
                            return
                        if '/api/admin/model-catalog' in url:
                            # 这条接口会在服务端去 geteapi.com / cgcm-api.com 抓目录 = 真实上游调用。
                            # 为了 0 外呼，这里用形状完整的桩拦掉；页面其余部分（Key 池、表单）仍是真的。
                            route.fulfill(status=200, content_type='application/json', body=json.dumps({
                                'ok': True,
                                'fetchedAt': '2026-11-27T00:00:00.000Z',
                                'platforms': [],
                                'routes': {'primaryCount': 0, 'referenceCount': 0, 'routes': []},
                                'rows': [],
                                'notes': ['取证桩：这一页的上游目录没有真请求'],
                            }, ensure_ascii=False))
                            return
                        route.continue_()
                    context.route('**/*', handler)
                page = context.new_page()
                return context, page

            # ── #3 普通用户界面：逐屏扫 ─────────────────────────────────
            context, page = new_page(user_token)
            user_routes = ['/', '/projects', '/templates', '/radar', '/rooms', '/agents', '/review', '/canvas', '/settings', '/legal/terms', '/legal/privacy', '/sources', '/help']
            total_hits = []
            for route in user_routes:
                try:
                    goto(page, route_url(vq_base, route))
                    text = scan(page)
                    found = hits(text)
                except Exception as error:
                    text, found = '', [{'token': 'nav-error', 'context': str(error)[:160]}]
                found = hits(text) if text else found
                total_hits.extend([{ 'route': route, **item } for item in found])
                check('(#3) 普通用户 ' + route + ' 0 厂牌/内部型号', not found, '命中=' + json.dumps(found[:3], ensure_ascii=False) if found else 'len=' + str(len(text)))
                if route == '/':
                    print('[scan-preview] / -> ' + json.dumps(text[:160], ensure_ascii=False))
            check('(#3) 普通用户逐屏合计 0 命中', not total_hits, '合计命中 ' + str(len(total_hits)) + ' 处')

            # 侧栏版本弹窗
            goto(page, route_url(vq_base, '/'))
            try:
                if not click_first(page, 'button[title="版本信息"]'):
                    raise RuntimeError('点不开版本按钮')
                page.wait_for_timeout(800)
                text = scan(page)
                found = hits(text)
                check('(#3) 侧栏版本弹窗 0 厂牌/内部型号', not found, '命中=' + json.dumps(found[:3], ensure_ascii=False) if found else 'ok')
                page.screenshot(path=os.path.join(SHOTS, 'version-dialog.png'))
                page.keyboard.press('Escape')
            except Exception as error:
                check('(#3) 侧栏版本弹窗能打开', False, str(error)[:200])
            page.screenshot(path=os.path.join(SHOTS, 'agents-desktop-before-chat.png'), full_page=False)

            # 真实发一条对话：看助手消息元信息里会不会把内部模型名显示出来
            goto(page, route_url(vq_base, '/agents'), wait=2500)
            chat_state = 'no-textarea'
            try:
                page.fill('textarea.qc-input', '你好，请回一句')
                if not click_first(page, 'button.qc-send[aria-label="发送"]'):
                    raise RuntimeError('点不到发送按钮')
                page.wait_for_selector('.qc-msg--assistant .qc-msg-meta', timeout=30000)
                page.wait_for_timeout(1200)
                chat_state = 'answered'
            except Exception as error:
                chat_state = 'error: ' + str(error)[:160]
            check('(#3) 对话真的发出去并拿到回答', chat_state == 'answered', chat_state)
            text_after = scan(page)
            meta_text = ''
            try:
                meta_text = page.inner_text('.qc-msg--assistant .qc-msg-meta')
            except Exception:
                meta_text = '（读不到元信息行）'
            found_after = hits(text_after)
            page.screenshot(path=os.path.join(SHOTS, 'agents-desktop-after-chat.png'))
            check(
                '(#3) 发过一条普通对话后，界面上仍 0 厂牌/内部型号',
                not found_after,
                '命中=' + json.dumps(found_after[:5], ensure_ascii=False) + ' · 元信息行=' + json.dumps(meta_text, ensure_ascii=False) if found_after else '0 命中',
            )
            context.close()

            # ── 反方向：?edition=admin 管理端仍保留厂牌 ───────────────────
            admin_context, admin_page = new_page(admin_token, block_external=True)
            admin_found = []
            for section in ['models', 'system']:
                goto(admin_page, vq_base + '/?edition=admin#/admin/' + section, wait=1200)
                if section == 'models':
                    # 这一页要等 /api/admin/model-keys 回来才画出 Key 池；等不到就说明页面没起来，
                    # 直接扫会得到「0 命中」的假绿。
                    try:
                        admin_page.wait_for_selector('text=平台 Key 池', timeout=25000)
                        admin_page.wait_for_timeout(600)
                    except Exception as error:
                        print('[admin] 等 Key 池超时：' + str(error)[:160])
                else:
                    admin_page.wait_for_timeout(1800)
                text = scan(admin_page)
                found = hits(text)
                admin_found.extend([{'section': section, **item} for item in found])
                print('[admin] /admin/' + section + ' len=' + str(len(text)) + ' 命中=' + str(len(found)) + ' tokens=' + json.dumps([item['token'] for item in found][:8], ensure_ascii=False))
                admin_page.screenshot(path=os.path.join(SHOTS, 'admin-' + section + '.png'))
            check(
                '(#3 反方向) ?edition=admin 管理端仍保留厂牌（两套口径）',
                len(admin_found) > 0,
                '命中 ' + str(len(admin_found)) + ' 处：' + json.dumps(admin_found[:5], ensure_ascii=False),
            )
            admin_context.close()

            # ── #5 390×844 无横向溢出 ───────────────────────────────────
            mobile_context, mobile = new_page(user_token, viewport={'width': 390, 'height': 844})
            for route in ['/', '/agents', '/rooms', '/legal/terms', '/templates', '/settings']:
                goto(mobile, route_url(vq_base, route), wait=1800)
                metrics = mobile.evaluate(
                    '''() => ({
                        scrollWidth: document.documentElement.scrollWidth,
                        bodyScrollWidth: document.body ? document.body.scrollWidth : -1,
                        innerWidth: window.innerWidth,
                        innerHeight: window.innerHeight,
                    })'''
                )
                ok = metrics['scrollWidth'] <= metrics['innerWidth'] and metrics['bodyScrollWidth'] <= metrics['innerWidth']
                check('(#5) 390 宽 ' + route + ' 无横向溢出', ok, json.dumps(metrics))
                if route in ('/', '/agents'):
                    mobile.screenshot(path=os.path.join(SHOTS, 'mobile-390' + route.replace('/', '-') + '.png'))

            # 对话里的生成设置行：输入 /生图 让那一行出现，再量一次
            goto(mobile, route_url(vq_base, '/agents'), wait=2200)
            gen_state = 'no-gen-row'
            try:
                mobile.fill('textarea.qc-input', '/生图 3:4 白底产品图')
                mobile.wait_for_selector('.qc-gen-row', timeout=10000)
                gen_state = 'shown'
            except Exception as error:
                gen_state = 'error: ' + str(error)[:160]
            check('(#5) 390 宽下生成设置行能出现', gen_state == 'shown', gen_state)
            if gen_state == 'shown':
                metrics = mobile.evaluate(
                    '''() => {
                        const row = document.querySelector('.qc-gen-row');
                        const rect = row.getBoundingClientRect();
                        return {
                            scrollWidth: document.documentElement.scrollWidth,
                            innerWidth: window.innerWidth,
                            rowScrollWidth: row.scrollWidth,
                            rowClientWidth: row.clientWidth,
                            rowRight: Math.round(rect.right),
                            rowLeft: Math.round(rect.left),
                            labels: [...row.querySelectorAll('button,span')].map((el) => (el.textContent || '').trim()).filter(Boolean),
                        };
                    }'''
                )
                ok = (
                    metrics['scrollWidth'] <= metrics['innerWidth']
                    and metrics['rowScrollWidth'] <= metrics['rowClientWidth'] + 1
                    and metrics['rowRight'] <= metrics['innerWidth'] + 1
                    and metrics['rowLeft'] >= -1
                )
                check('(#5) 390 宽生成设置行不溢出、文案没被挤掉', ok, json.dumps(metrics, ensure_ascii=False))
                mobile.screenshot(path=os.path.join(SHOTS, 'mobile-390-gen-row.png'))
            mobile_context.close()
            browser.close()
    finally:
        for child in CHILDREN:
            kill_tree(child)
        fake_server.shutdown()

    failed = [item for item in results if not item[1]]
    print('')
    print('==== r343 · #3 界面 0 厂牌 / #5 390 宽 ====')
    print('共 ' + str(len(results)) + ' 条，通过 ' + str(len(results) - len(failed)) + '，失败 ' + str(len(failed)))
    for item in failed:
        print('  FAIL · ' + item[0] + ' :: ' + item[2])
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
