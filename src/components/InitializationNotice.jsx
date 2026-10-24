import { useAppFields } from '../context/AppContext'

const labels = { settings: '应用设置', plugins: '插件列表', ffmpeg: 'FFmpeg 状态', mpv: 'mpv 状态' }
export default function InitializationNotice() {
  const { initializationErrors = {}, initializationPending = {}, retryInitialization } = useAppFields(['initializationErrors', 'initializationPending', 'retryInitialization'])
  const failed = Object.entries(labels).filter(([key]) => initializationErrors[key] || initializationPending[key])
  if (!failed.length) return null
  return <section className="initialization-notice" aria-label="启动数据状态">
    {failed.map(([key, label]) => <div key={key}>
      <p role={initializationErrors[key] ? 'alert' : 'status'}>{label}：{initializationErrors[key] || '正在读取...'}</p>
      {initializationErrors[key] || initializationPending[key] && key !== 'settings' ? <button className="btn btn-sm" type="button" disabled={initializationPending[key]} onClick={() => retryInitialization(key)}>
        {initializationPending[key] ? '重试中...' : `重试${label}`}
      </button> : null}
    </div>)}
  </section>
}
