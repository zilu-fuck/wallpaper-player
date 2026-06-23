import { formatTime } from './playerFormat'

export default function PlayerProgressPreview({ duration, progressPreview }) {
  if (!progressPreview.visible || duration <= 0) return null

  return (
    <div className="player-progress-preview-layer" aria-hidden="true">
      <div
        className="player-progress-preview"
        style={{ left: progressPreview.x }}
      >
        <div className="player-progress-preview-image">
          {progressPreview.imageUrl ? (
            <img src={progressPreview.imageUrl} alt="" draggable="false" />
          ) : (
            <span>{progressPreview.loading ? '加载中' : '无预览'}</span>
          )}
        </div>
        <span className="player-progress-preview-time">{formatTime(progressPreview.time)}</span>
      </div>
    </div>
  )
}
