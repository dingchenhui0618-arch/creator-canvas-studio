// 监听方式：默认自己 bind 端口；有 systemd socket 激活时改用继承来的套接字。
//
// 为什么（B3 发布不中断）：发版 = systemctl restart = 进程退出 → 端口断开 → nginx 连不上
// → 用户看到 3–10 秒的 502。systemd socket 单元可以「替进程一直握着这个端口」，
// 重启时端口不断开：新连接进入监听队列排队，等新进程起来再被 accept，
// 于是发版变成「等一两秒」而不是「报错」。
//
// systemd 的约定：LISTEN_FDS = 传过来的 fd 数量（从 3 开始编号），LISTEN_PID = 目标进程。
// LISTEN_PID 必须等于当前 pid，否则是别的进程继承来的 fd，宁可不 listen 也不要听错端口。
//
// 这里只做「该不该用继承 fd」这一件事，方便单测；真正 listen 在 index.mjs。
export function inheritedListenFd(env = process.env, pid = process.pid) {
  // 测试 / 特殊部署用：显式指定 fd（本地 e2e 用它模拟 systemd）
  const explicit = String(env.VQ_LISTEN_FD || '').trim()
  if (explicit) {
    const fd = Number(explicit)
    return Number.isInteger(fd) && fd >= 0 ? fd : null
  }
  const count = Number(env.LISTEN_FDS || 0)
  const target = Number(env.LISTEN_PID || 0)
  if (count !== 1) return null
  if (!target || target !== Number(pid)) return null
  return 3
}

/** 给日志和后台看的一行：这次到底是怎么听上端口的。 */
export function listenMode(fd) {
  return fd === null || fd === undefined ? 'port' : 'systemd-socket'
}
