// 监听方式（v0.9.71，B3 发布不中断）。
// 这一组只钉住「该不该用继承来的套接字」这一条判断——
// 真正的 listen({fd}) 由 e2e 在 Linux 上验（Windows 不支持 fd 继承，本机跑不了）。
// 判断错了的后果很具体：听错 fd 会起不来，或者在 socket 激活生效时又去 bind 同一个端口（EADDRINUSE）。
import test from 'node:test'
import assert from 'node:assert/strict'
const { inheritedListenFd, listenMode } = await import('../server/listen.mjs')

test('systemd 约定：LISTEN_FDS=1 且 LISTEN_PID 是自己 → 用 fd 3', () => {
  assert.equal(inheritedListenFd({ LISTEN_FDS: '1', LISTEN_PID: '4242' }, 4242), 3)
})

test('LISTEN_PID 不是自己就不听：那是别的进程继承来的 fd', () => {
  assert.equal(inheritedListenFd({ LISTEN_FDS: '1', LISTEN_PID: '1111' }, 4242), null)
})

test('没有 socket 单元（或传了多个 fd）→ 自己 bind 端口', () => {
  assert.equal(inheritedListenFd({}, 4242), null)
  assert.equal(inheritedListenFd({ LISTEN_FDS: '0', LISTEN_PID: '4242' }, 4242), null)
  assert.equal(inheritedListenFd({ LISTEN_FDS: '2', LISTEN_PID: '4242' }, 4242), null)
  // LISTEN_FDS 有但 LISTEN_PID 缺失：宁可不听，也不要去听一个来路不明的 fd
  assert.equal(inheritedListenFd({ LISTEN_FDS: '1' }, 4242), null)
})

test('VQ_LISTEN_FD 可显式指定（本地 e2e 用它模拟 systemd），非法值当没配', () => {
  assert.equal(inheritedListenFd({ VQ_LISTEN_FD: '5' }, 4242), 5)
  assert.equal(inheritedListenFd({ VQ_LISTEN_FD: 'abc' }, 4242), null)
  assert.equal(inheritedListenFd({ VQ_LISTEN_FD: '-1' }, 4242), null)
})

test('日志口径：两种听法要能一眼分开', () => {
  assert.equal(listenMode(3), 'systemd-socket')
  assert.equal(listenMode(null), 'port')
})
