// 交付包里的「校验.html」（v0.9.133）：让收包人自己就能对一遍。
//
// 为什么做在包里，而不是只留在我们这边：
//  1. 收到 zip 的人没有账号、也不该为了核对一份包去注册。整件事在收包人自己的
//     电脑上算完，不上传、不联网，符合「交付物自带证据」这条线。
//  2. 包是 store（不压缩）打的，条目内容就在本地头后面；浏览器里读中央目录、
//     逐条按偏移取字节、重算 CRC32，与服务器上那次「体检整包」是同一套判据。
//  3. 清单在打包时写进页面（不含这一页自己——它没法记自己的哈希）。所以这一页
//     能发现下载不全、字节被换、多出/少了条目；发现不了「对方一开始就给你一份
//     改过的包」，那种情况只能比整包 SHA-256 或让对方重发，页面上如实这么写。
//  4. 核对完给一张「收据」：一段人话（谁、哪一份、结论、整包 SHA-256、时间、坏在
//     哪），可以复制或存成 txt 发回给发件人。仍然不联网：文字在本地生成。
//
// 安全：作品标题、文件名一律先 escapeHtml 再进 HTML；交互结果全部用 textContent
// 写进 DOM，文件名里带 < > 也只会显示成字。
import { crc32, safeEntryName } from './zip-store.mjs'
import { escapeHtml, paperShell } from './project-deliverable-html.mjs'

/** 包内这一页的名字：说明.txt、交付记录、测试都引这个名字。 */
export const VERIFY_PAGE_NAME = '校验.html'

const pad2 = (value) => String(value).padStart(2, '0')

/** 打包时间按作品时区写：收件人看到的是「打包那天」而不是 UTC 的隔夜时间。 */
function stampText(iso, tzOffsetMinutes) {
  const ms = Date.parse(String(iso || ''))
  if (!Number.isFinite(ms)) return '打包时间未知'
  const date = new Date(ms + (Number(tzOffsetMinutes) || 0) * 60000)
  return (
    String(date.getUTCFullYear()) + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate()) +
    ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes())
  )
}

/**
 * 页面里那份清单：文件名 + 字节数 + CRC32。不含这一页自己。
 * 纯函数，测试可以拿它跟真 zip 的条目逐条对。
 */
export function packageVerifyManifest({ zipName = '', files = [] } = {}) {
  const list = (Array.isArray(files) ? files : [])
    .map((file) => ({
      n: String(file?.name || ''),
      b: Math.max(0, Math.round(Number(file?.bytes) || 0)),
      c: Number(file?.crc32) >>> 0,
    }))
    .filter((file) => file.n)
  return { version: 1, zip: String(zipName || ''), self: VERIFY_PAGE_NAME, files: list }
}

const VERIFY_CSS = [
  ':root { --ok: #1f6b4a; --fail: #a4232b; }',
  '.vf-tag { display: inline-block; padding: 2pt 8pt; border: 0.5pt solid var(--line-strong); border-radius: 999px; font-family: var(--mono); font-size: 7pt; letter-spacing: 0.06em; color: var(--muted); white-space: nowrap; }',
  // 拖放区：虚线框 + 一行标题一行小字；点在哪儿都能选文件（label for 输入框）
  '.vf-drop { display: flex; flex-direction: column; align-items: center; gap: 4pt; margin: 0 0 12pt; padding: 22pt 12pt; border: 1pt dashed var(--line-strong); border-radius: 6pt; background: #fbfbfb; cursor: pointer; text-align: center; }',
  '.vf-drop:hover, .vf-drop.is-over { border-color: var(--ink); background: #f6f6f6; }',
  '.vf-drop:focus-within { outline: 2pt solid var(--ink); outline-offset: 2pt; }',
  '.vf-drop-title { font-size: 11pt; font-weight: 500; line-height: 1.4; }',
  '.vf-drop-note { font-size: 8.5pt; line-height: 1.5; color: var(--faint); }',
  '.vf-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }',
  '.vf-out[hidden] { display: none; }',
  // 脚本没跑起来（被 CSP 拦下 / 浏览器禁用脚本）时留下的这句：不然读者只看到一张空纸
  '.vf-needjs { margin: -4pt 0 12pt; padding: 6pt 10pt; border-left: 2pt solid var(--line-strong); background: #fafafa; font-size: 8.5pt; line-height: 1.6; color: var(--muted); }',
  '.vf-needjs[hidden] { display: none; }',
  // 结论条：通过是绿边，有问题红边；颜色只在这一条与坏行的字上用
  '.vf-sum { display: flex; align-items: center; gap: 8pt; margin: 0 0 10pt; padding: 8pt 10pt; border: 0.75pt solid var(--line-strong); border-radius: 4pt; background: #fcfcfc; }',
  '.vf-sum.is-ok { border-color: var(--ok); background: #f4f8f5; }',
  '.vf-sum.is-bad { border-color: var(--fail); background: #fbf4f4; }',
  '.vf-sum.is-error { border-color: var(--line-strong); background: #f6f6f6; }',
  '.vf-chip { flex: none; padding: 2pt 8pt; border: 0.5pt solid currentColor; border-radius: 999px; font-family: var(--mono); font-size: 7.5pt; letter-spacing: 0.04em; white-space: nowrap; }',
  '.vf-sum.is-ok .vf-chip { color: var(--ok); }',
  '.vf-sum.is-bad .vf-chip { color: var(--fail); }',
  '.vf-sum.is-error .vf-chip { color: var(--muted); }',
  '.vf-sum-text { margin: 0; font-size: 10pt; line-height: 1.55; }',
  '.vf-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2pt 12pt; margin: 0 0 12pt; font-size: 8.5pt; line-height: 1.55; }',
  '.vf-meta-k { color: var(--faint); }',
  '.vf-meta-v { min-width: 0; overflow-wrap: anywhere; }',
  '.vf-hash { font-family: var(--mono); font-size: 8pt; letter-spacing: 0.01em; }',
  '.vf-table { width: 100%; margin: 0 0 10pt; border-collapse: collapse; font-size: 9pt; line-height: 1.5; }',
  '.vf-table th { padding: 4pt 6pt; border-bottom: 0.75pt solid var(--line-strong); font-size: 8pt; font-weight: 500; color: var(--muted); text-align: left; white-space: nowrap; }',
  '.vf-table td { padding: 4pt 6pt; border-bottom: 0.5pt solid var(--line-faint); vertical-align: top; }',
  '.vf-table th:first-child, .vf-table td:first-child { white-space: normal; }',
  '.vf-table td.vf-name { overflow-wrap: anywhere; }',
  '.vf-table td.vf-num { font-family: var(--mono); font-size: 8pt; white-space: nowrap; }',
  '.vf-table td.vf-verdict { font-size: 8.5pt; white-space: nowrap; }',
  '.vf-table tr.is-bad td.vf-name, .vf-table tr.is-bad td.vf-verdict { color: var(--fail); font-weight: 500; }',
  '.vf-table tr.is-extra td.vf-verdict { color: var(--fail); }',
  '.vf-table tr.is-self td.vf-verdict { color: var(--faint); }',
  // 带走这份结论：一段可直接复制的文字 + 存成 txt；按钮在打印时收起来
  '.vf-receipt { margin: 14pt 0 0; padding: 10pt 12pt; border: 0.5pt solid var(--line-strong); border-radius: 4pt; background: #fcfcfc; break-inside: avoid; }',
  '.vf-receipt-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8pt; margin: 0 0 6pt; }',
  '.vf-receipt-title { margin: 0; font-size: 9.5pt; font-weight: 500; line-height: 1.5; }',
  '.vf-receipt-row { display: flex; flex-wrap: wrap; gap: 6pt; }',
  '.vf-btn { padding: 3pt 10pt; border: 0.5pt solid var(--line-strong); border-radius: 999px; background: #fff; font-family: var(--body); font-size: 8.5pt; line-height: 1.5; color: var(--ink); cursor: pointer; }',
  '.vf-btn:hover { border-color: var(--ink); }',
  '.vf-btn:focus-visible { outline: 2pt solid var(--ink); outline-offset: 2pt; }',
  '.vf-receipt-text { margin: 0; padding: 8pt 10pt; border: 0.5pt solid var(--line); border-radius: 3pt; background: #fff; font-family: var(--body); font-size: 8.5pt; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }',
  '.vf-receipt-note { margin: 6pt 0 0; font-size: 8pt; line-height: 1.6; color: var(--faint); }',
  '@media print { .vf-receipt-row { display: none; } }',
  '.vf-foot { margin: 12pt 0 0; padding-top: 8pt; border-top: 0.5pt solid var(--line); font-size: 8pt; line-height: 1.7; color: var(--faint); }',
  // 窄屏：CRC32 那一列收起来（核对仍然照做，只是不占地方），四列变三列不横向溢出
  '@media (max-width: 560px) {',
  '  .vf-table th:nth-child(3), .vf-table td:nth-child(3) { display: none; }',
  '  .vf-drop { padding: 16pt 8pt; }',
  '}',
]

// 页面脚本：只读文件、只算不改。字符串常量（不接用户内容），所以直接内联。
const VERIFY_SCRIPT = [
  '(function () {',
  '  "use strict";',
  '  var M = JSON.parse(document.getElementById("vq-manifest").textContent);',
  '  var input = document.getElementById("vq-file");',
  '  var drop = document.getElementById("vq-drop");',
  '  var out = document.getElementById("vq-out");',
  '  var needJs = document.getElementById("vq-needjs");',
  '  if (needJs) needJs.hidden = true;',
  '  var CRC = (function () {',
  '    var t = new Int32Array(256);',
  '    for (var n = 0; n < 256; n += 1) {',
  '      var c = n;',
  '      for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);',
  '      t[n] = c;',
  '    }',
  '    return t;',
  '  })();',
  '  function crc32(bytes) {',
  '    var c = -1;',
  '    for (var i = 0; i < bytes.length; i += 1) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);',
  '    return (c ^ -1) >>> 0;',
  '  }',
  '  function u16(b, o) { return b[o] | (b[o + 1] << 8); }',
  '  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }',
  '  var HEX = "0123456789abcdef";',
  '  function hex32(v) {',
  '    var s = "";',
  '    for (var i = 7; i >= 0; i -= 1) s += HEX[(v >>> (i * 4)) & 0xf];',
  '    return s.toUpperCase();',
  '  }',
  '  function sizeText(n) {',
  '    var s = String(n), out = "", d = 0;',
  '    for (var i = s.length - 1; i >= 0; i -= 1) {',
  '      out = s.charAt(i) + out;',
  '      d += 1;',
  '      if (d % 3 === 0 && i > 0) out = "," + out;',
  '    }',
  '    return out + " B";',
  '  }',
  '  function el(tag, cls, text) {',
  '    var node = document.createElement(tag);',
  '    if (cls) node.className = cls;',
  '    if (text !== undefined && text !== null) node.textContent = String(text);',
  '    return node;',
  '  }',
  '  function nameOf(bytes, from, len) {',
  '    try { return new TextDecoder("utf-8").decode(bytes.subarray(from, from + len)); }',
  '    catch (error) { return ""; }',
  '  }',
  '  // 读 zip：找尾记录（注释长度必须正好到头）→ 读中央目录 → 逐条按本地头取字节、重算 CRC32',
  '  function readZip(buf) {',
  '    if (buf.length < 22) return { error: "这个文件太小，不像一个 zip。" };',
  '    var max = Math.min(buf.length, 65557);',
  '    var eocd = -1;',
  '    for (var i = buf.length - 22; i >= buf.length - max; i -= 1) {',
  '      if (u32(buf, i) === 0x06054b50 && i + 22 + u16(buf, i + 20) === buf.length) { eocd = i; break; }',
  '    }',
  '    if (eocd < 0) return { error: "找不到 zip 的尾记录：这个文件多半没下全，或者拖进来的不是 zip。" };',
  '    var count = u16(buf, eocd + 10);',
  '    var cdSize = u32(buf, eocd + 12);',
  '    var cdOffset = u32(buf, eocd + 16);',
  '    if (count === 0xffff || cdOffset === 0xffffffff) return { error: "这个包超过 4 GB（ZIP64），这个页面读不了。" };',
  '    if (cdOffset + cdSize > eocd) return { error: "zip 的目录越界了：这个文件被截断过。" };',
  '    var entries = [];',
  '    var p = cdOffset;',
  '    for (var n = 0; n < count; n += 1) {',
  '      if (u32(buf, p) !== 0x02014b50) return { error: "zip 目录第 " + (n + 1) + " 条读不出来。" };',
  '      var nameLen = u16(buf, p + 28);',
  '      var extraLen = u16(buf, p + 30);',
  '      var commentLen = u16(buf, p + 32);',
  '      entries.push({',
  '        name: nameOf(buf, p + 46, nameLen),',
  '        method: u16(buf, p + 10),',
  '        size: u32(buf, p + 24),',
  '        local: u32(buf, p + 42),',
  '        problem: "",',
  '      });',
  '      p += 46 + nameLen + extraLen + commentLen;',
  '    }',
  '    for (var j = 0; j < entries.length; j += 1) {',
  '      var entry = entries[j];',
  '      if (entry.local + 30 > buf.length || u32(buf, entry.local) !== 0x04034b50) { entry.problem = "本地头对不上，包在这一条坏了"; continue; }',
  '      var start = entry.local + 30 + u16(buf, entry.local + 26) + u16(buf, entry.local + 28);',
  '      if (start + entry.size > buf.length) { entry.problem = "数据超出文件末尾，这条没下全"; continue; }',
  '      if (entry.method !== 0) { entry.problem = "这一条是压缩存的，这个页面只认不压缩的包"; continue; }',
  '      entry.crcNow = crc32(buf.subarray(start, start + entry.size));',
  '    }',
  '    return { entries: entries };',
  '  }',
  '  function judge(buf, zip) {',
  '    var want = new Map();',
  '    M.files.forEach(function (file) { want.set(file.n, file); });',
  '    var rows = [];',
  '    var bad = 0, extra = 0, unread = 0;',
  '    var seen = new Map();',
  '    zip.entries.forEach(function (entry) {',
  '      var row = { name: entry.name, bytes: entry.size, crc: 0, status: "ok", note: "对得上" };',
  '      if (entry.name === M.self) { row.status = "self"; row.note = "这一页自己"; rows.push(row); return; }',
  '      seen.set(entry.name, true);',
  '      var expect = want.get(entry.name);',
  '      if (entry.problem) { row.status = "bad"; row.note = entry.problem; bad += 1; rows.push(row); return; }',
  '      row.crc = entry.crcNow;',
  '      if (!expect) { row.status = "extra"; row.note = "清单里没有这一条"; extra += 1; rows.push(row); return; }',
  '      if (entry.size !== expect.b) { row.status = "bad"; row.note = "字节数对不上：清单里是 " + sizeText(expect.b); bad += 1; rows.push(row); return; }',
  '      if (entry.crcNow !== expect.c) { row.status = "bad"; row.note = "CRC32 对不上：清单里是 " + hex32(expect.c); bad += 1; rows.push(row); return; }',
  '      rows.push(row);',
  '    });',
  '    var missing = [];',
  '    want.forEach(function (file) { if (!seen.has(file.n)) missing.push(file.n); });',
  '    var problems = [];',
  '    if (bad) problems.push(bad + " 个文件对不上");',
  '    if (extra) problems.push("多了 " + extra + " 条清单里没有的文件");',
  '    if (missing.length) problems.push("少了 " + missing.length + " 个文件：" + missing.slice(0, 5).join("、") + (missing.length > 5 ? " 等" : ""));',
  '    var total = rows.filter(function (row) { return row.status !== "self"; }).length;',
  '    var ok = !problems.length;',
  '    return {',
  '      state: ok ? "ok" : "bad",',
  '      chip: ok ? "都对得上" : "有问题",',
  '      summary: ok',
  '        ? total + " 个文件都对得上：字节数与 CRC32 都和打包时记下的清单一致。"',
  '        : problems.join("；") + "。以下是逐条结论。",',
  '      rows: rows,',
  '    };',
  '  }',
  '  function meta(container, key, value, cls) {',
  '    container.appendChild(el("span", "vf-meta-k", key));',
  '    var node = el("span", "vf-meta-v" + (cls ? " " + cls : ""), value);',
  '    container.appendChild(node);',
  '    return node;',
  '  }',
  '  function pad2(v) { return (v < 10 ? "0" : "") + v; }',
  '  function stampNow() {',
  '    var now = new Date();',
  '    return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate()) + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes());',
  '  }',
  '  function stampFile() {',
  '    var now = new Date();',
  '    return String(now.getFullYear()) + pad2(now.getMonth() + 1) + pad2(now.getDate()) + "-" + pad2(now.getHours()) + pad2(now.getMinutes());',
  '  }',
  '  // 收据：一段人能直接发回给发件人的文字（谁、哪一份、结论、整包哈希、时间、坏在哪）',
  '  function receiptText(file, buf, info) {',
  '    var project = M.project || {};',
  '    var head = "VisionQA " + (M.kind || "离线包") + "核对";',
  '    if (project.title) {',
  '      head += " · " + project.title + (project.version ? " v" + project.version : "");',
  '    }',
  '    var lines = [head];',
  '    lines.push("包：" + (M.zip || file.name));',
  '    lines.push("结论：" + info.chip + " · " + info.summary);',
  '    lines.push("整包：" + sizeText(buf.byteLength) + " · SHA-256 " + (info.hash || "没算（读不出来，或这个浏览器不给算）"));',
  '    lines.push("时间：" + stampNow());',
  '    var problems = (info.problems || []).slice(0, 3).map(function (row) { return row.name + "（" + row.note + "）"; });',
  '    if (problems.length) {',
  '      lines.push("对不上的：" + problems.join("；") + (info.problems.length > 3 ? " 等 " + info.problems.length + " 条" : ""));',
  '    }',
  '    return lines.join("\\n");',
  '  }',
  '  function paintReceipt(file, buf, info) {',
  '    var text = receiptText(file, buf, info);',
  '    var block = el("div", "vf-receipt");',
  '    var box = el("div", "vf-receipt-head");',
  '    box.appendChild(el("p", "vf-receipt-title", "带走这份结论"));',
  '    var row = el("div", "vf-receipt-row");',
  '    var copy = el("button", "vf-btn", "复制这段");',
  '    copy.type = "button";',
  '    var save = el("button", "vf-btn", "存成 核对结果.txt");',
  '    save.type = "button";',
  '    row.appendChild(copy);',
  '    row.appendChild(save);',
  '    box.appendChild(row);',
  '    block.appendChild(box);',
  '    var pre = el("pre", "vf-receipt-text", text);',
  '    block.appendChild(pre);',
  '    var note = el("p", "vf-receipt-note", "把这段复制下来发回给发你的人：他就不用再问「你那边验过了吗」。这段文字只在你自己的电脑上生成，不会上传。");',
  '    note.id = "vq-receipt-note";',
  '    block.appendChild(note);',
  '    copy.addEventListener("click", function () {',
  '      var select = function () {',
  '        try {',
  '          var range = document.createRange();',
  '          range.selectNodeContents(pre);',
  '          var selection = window.getSelection();',
  '          selection.removeAllRanges();',
  '          selection.addRange(range);',
  '        } catch (error) { /* 选不了也还能手动选 */ }',
  '      };',
  '      var fallback = function () {',
  '        select();',
  '        var copied = false;',
  '        try { copied = document.execCommand("copy"); } catch (error) { copied = false; }',
  '        note.textContent = copied',
  '          ? "已复制，可以直接粘到微信或邮件里。"',
  '          : "这段文字已经选中，按 Ctrl+C 也能复制。";',
  '      };',
  '      if (navigator.clipboard && navigator.clipboard.writeText) {',
  '        navigator.clipboard.writeText(text).then(function () {',
  '          note.textContent = "已复制，可以直接粘到微信或邮件里。";',
  '        }, fallback);',
  '      } else {',
  '        fallback();',
  '      }',
  '    });',
  '    save.addEventListener("click", function () {',
  '      try {',
  '        var blob = new Blob(["\\ufeff" + text], { type: "text/plain;charset=utf-8" });',
  '        var url = URL.createObjectURL(blob);',
  '        var link = document.createElement("a");',
  '        link.href = url;',
  '        link.download = "核对结果-" + stampFile() + ".txt";',
  '        document.body.appendChild(link);',
  '        link.click();',
  '        document.body.removeChild(link);',
  '        window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);',
  '        note.textContent = "已存成 核对结果-" + stampFile() + ".txt（在浏览器的下载目录里）。";',
  '      } catch (error) {',
  '        note.textContent = "这个浏览器不让存文件；可以用旁边的「复制这段」。";',
  '      }',
  '    });',
  '    out.appendChild(block);',
  '  }',
  '  function paint(file, buf, zip) {',
  '    out.textContent = "";',
  '    out.hidden = false;',
  '    if (zip.error) {',
  '      var bad = el("div", "vf-sum is-error");',
  '      bad.appendChild(el("span", "vf-chip", "读不出来"));',
  '      bad.appendChild(el("p", "vf-sum-text", zip.error));',
  '      out.appendChild(bad);',
  '      paintReceipt(file, buf, { state: "error", chip: "读不出来", summary: zip.error, problems: [], hash: "" });',
  '      return;',
  '    }',
  '    var result = judge(buf, zip);',
  '    var sum = el("div", "vf-sum is-" + result.state);',
  '    sum.appendChild(el("span", "vf-chip", result.chip));',
  '    sum.appendChild(el("p", "vf-sum-text", result.summary));',
  '    out.appendChild(sum);',
  '    var box = el("div", "vf-meta");',
  '    meta(box, "收到的文件", file.name);',
  '    meta(box, "字节", sizeText(buf.byteLength));',
  '    var hashNode = meta(box, "整包 SHA-256", "计算中…", "vf-hash");',
  '    out.appendChild(box);',
  '    var table = el("table", "vf-table");',
  '    var head = el("tr");',
  '    ["文件", "字节", "CRC32", "结论"].forEach(function (label) { head.appendChild(el("th", "", label)); });',
  '    var thead = el("thead");',
  '    thead.appendChild(head);',
  '    table.appendChild(thead);',
  '    var tbody = el("tbody");',
  '    result.rows.forEach(function (row) {',
  '      var tr = el("tr", row.status === "ok" ? "" : "is-" + row.status);',
  '      tr.appendChild(el("td", "vf-name", row.name));',
  '      tr.appendChild(el("td", "vf-num", sizeText(row.bytes)));',
  '      tr.appendChild(el("td", "vf-num", row.status === "ok" || row.status === "bad" ? hex32(row.crc) : "—"));',
  '      tr.appendChild(el("td", "vf-verdict", row.note));',
  '      tbody.appendChild(tr);',
  '    });',
  '    table.appendChild(tbody);',
  '    out.appendChild(table);',
  '    var done = function (hash) {',
  '      paintReceipt(file, buf, {',
  '        state: result.state,',
  '        chip: result.chip,',
  '        summary: result.summary,',
  '        problems: result.rows.filter(function (row) { return row.status === "bad" || row.status === "extra"; }),',
  '        hash: hash,',
  '      });',
  '    };',
  '    if (window.crypto && window.crypto.subtle) {',
  '      window.crypto.subtle.digest("SHA-256", buf).then(function (digest) {',
  '        var bytes = new Uint8Array(digest), hex = "";',
  '        for (var i = 0; i < bytes.length; i += 1) hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);',
  '        hashNode.textContent = hex;',
  '        done(hex);',
  '      }, function () { hashNode.textContent = "这个浏览器不给算，跳过这一项"; done(""); });',
  '    } else {',
  '      hashNode.textContent = "这个浏览器不给算，跳过这一项";',
  '      done("");',
  '    }',
  '  }',
  '  function verify(file) {',
  '    if (!file) return;',
  '    file.arrayBuffer().then(function (buf) {',
  '      paint(file, buf, readZip(new Uint8Array(buf)));',
  '    }, function () {',
  '      paint(file, new ArrayBuffer(0), { error: "这个文件读不出来，换一份再试。" });',
  '    });',
  '  }',
  '  input.addEventListener("change", function () { verify(input.files && input.files[0]); });',
  '  ["dragenter", "dragover"].forEach(function (name) {',
  '    drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.add("is-over"); });',
  '  });',
  '  ["dragleave", "dragend"].forEach(function (name) {',
  '    drop.addEventListener(name, function () { drop.classList.remove("is-over"); });',
  '  });',
  '  drop.addEventListener("drop", function (event) {',
  '    event.preventDefault();',
  '    drop.classList.remove("is-over");',
  '    var files = event.dataTransfer && event.dataTransfer.files;',
  '    verify(files && files[0]);',
  '  });',
  '})();',
].join('\n')

/**
 * 包里的校验页：清单写进页面，脚本在收包人自己的浏览器里跑。
 * entries 传包内条目（不含这一页自己），顺序与 zip 里一致。
 * packageKind 只改纸上那句话（交付包 / 离线包），判据与脚本完全一样。
 */
export function packageVerifyHtml({
  project = {},
  zipName = '',
  entries = [],
  generatedAt = '',
  tzOffsetMinutes = 480,
  packageKind = '交付包',
} = {}) {
  // 清单与 zip 条目同一套字节：这里重算一遍 CRC32，和打包时写进中央目录的那个值同源
  const files = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const data = Buffer.isBuffer(entry?.data) ? entry.data : Buffer.from(entry?.data ?? '', 'utf8')
      return { name: safeEntryName(entry?.name || ''), bytes: data.length, crc32: crc32(data) }
    })
    .filter((file) => file.name)
  const manifest = packageVerifyManifest({ zipName, files })
  const kind = String(packageKind || '交付包')
  const title = String(project.title || '未命名作品')
  const version = Math.max(1, Math.round(Number(project.version) || 0))
  // 收据要写清「哪一份」：作品名与版次本来就是纸面上公开的信息，放进清单给页面脚本用。
  // kind 只用来让收据抬头写「交付包核对」还是「离线包核对」，判据与清单一个字不变。
  manifest.project = { title, version }
  manifest.kind = kind
  const count = manifest.files.length
  const blob = JSON.stringify(manifest).replace(/</g, '\\u003c')
  const body =
    '<main class="sheet">\n' +
    '<div class="sheet-brand">\n' +
    '<span class="sheet-textbrand">VisionQA</span>\n' +
    '<span class="sheet-brand-right"><span class="vf-tag">离线可用</span>' +
    '<span class="sheet-kind">PACKAGE CHECK</span></span>\n' +
    '</div>\n' +
    '<div class="sheet-body">\n' +
    '<h1 class="sheet-title">这份包，东西齐不齐、有没有坏</h1>\n' +
    '<p class="lede">把收到的 zip 拖到下边的虚线框里。核对在你自己这台电脑上做：不上传、不联网，也不需要账号。</p>\n' +
    '<p class="vf-needjs" id="vq-needjs">这一页要靠脚本核对。请把 zip 解压后双击打开它；在网页预览里脚本会被拦下，看到的是一张静态的纸。</p>\n' +
    '<ul class="sheet-facts">\n' +
    (zipName ? '<li><span class="fact-k">包</span><span class="fact-v">' + escapeHtml(zipName) + '</span></li>\n' : '') +
    '<li><span class="fact-k">作品</span><span class="fact-v">' + escapeHtml(title) + ' · v' + version +
      (project.id ? ' · ' + escapeHtml(project.id) : '') + '</span></li>\n' +
    '<li><span class="fact-k">打包时间</span><span class="fact-v">' + escapeHtml(stampText(generatedAt, tzOffsetMinutes)) + '</span></li>\n' +
    '<li><span class="fact-k">清单</span><span class="fact-v">' + count + ' 个文件的字节数与 CRC32（不含这一页自己）</span></li>\n' +
    '</ul>\n' +
    '<label class="vf-drop" id="vq-drop" for="vq-file">\n' +
    '<span class="vf-drop-title">把 zip 拖到这里</span>\n' +
    '<span class="vf-drop-note">或者点一下选文件；只会被读一遍，不会上传</span>\n' +
    '<input class="vf-file" type="file" id="vq-file" accept=".zip,application/zip">\n' +
    '</label>\n' +
    '<div class="vf-out" id="vq-out" hidden></div>\n' +
    '<p class="vf-foot">' +
    '这一页能发现：包没下全、文件坏了、条目被换过（跟打包时记下的清单对不上）。<br>' +
    '发现不了：一开始就收到一份被改过的包 —— 那种只能比整包 SHA-256，跟发件人给你的那一串核对，或者让对方重发。<br>' +
    '结果只在你自己这台电脑上算，关掉这一页就没了。' +
    '</p>\n' +
    '<script type="application/json" id="vq-manifest">' + blob + '</script>\n' +
    '</div>\n' +
    '</main>'
  return paperShell(title + ' · ' + kind + '校验 · VisionQA', body, VERIFY_CSS.join('\n'), VERIFY_SCRIPT)
}
