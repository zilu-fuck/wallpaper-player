// window.electronAPI 的统一访问门面。
// 组件/hook 一律从这里取 API，不要直接访问 window.electronAPI，
// 便于将来替换实现（如按域拆 service 模块）与统一错误处理。

export function getElectronAPI() {
  return window.electronAPI
}

/** 从 IPC 结果中解出错误信息；调用方按需使用 */
export function getIpcErrorMessage(result) {
  if (result && typeof result === 'object') {
    if (typeof result.error === 'string' && result.error) return result.error
  }
  return ''
}

/** 将 IPC 调用失败统一转为抛错，便于 try/catch 一处处理 */
export async function unwrapIpc(promise, fallbackMessage = '操作失败') {
  let result
  try {
    result = await promise
  } catch (err) {
    throw new Error(err?.message || fallbackMessage)
  }
  if (result && typeof result === 'object' && result.success === false) {
    throw new Error(result.error || fallbackMessage)
  }
  return result
}
