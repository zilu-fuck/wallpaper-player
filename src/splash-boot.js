// 开屏计时起点：必须早于 React 挂载，供 splash.js 计算最短展示时长。
window.__splashClock = typeof window.performance?.now === 'function' ? 'performance' : 'date'
window.__splashStartedAt = window.__splashClock === 'performance'
  ? window.performance.now()
  : Date.now()
