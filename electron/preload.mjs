// 预加载脚本：只暴露一个明确的小接口，不把 ipcRenderer / node 交出去。
// 网页版没有这个对象，界面据此判断「现在是不是桌面端」。
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('visionqaDesktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    choose: () => ipcRenderer.invoke('workspace:choose'),
  },
  agent: {
    listThreads: () => ipcRenderer.invoke('agent:threads:list'),
    createThread: () => ipcRenderer.invoke('agent:threads:create'),
    getThread: (id) => ipcRenderer.invoke('agent:threads:get', id),
    deleteThread: (id) => ipcRenderer.invoke('agent:threads:delete', id),
    send: (threadId, text) => ipcRenderer.invoke('agent:send', { threadId, text }),
    abort: () => ipcRenderer.invoke('agent:abort'),
    approve: (id, allow) => ipcRenderer.invoke('agent:approve', { id, allow }),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    },
  },
})