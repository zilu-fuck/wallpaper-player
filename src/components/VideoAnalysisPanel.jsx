function formatTime(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return '00:00'
  const total = Math.floor(value)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function getTimelineTitle(item) {
  if (item?.title) return item.title
  return `${formatTime(item?.start_time)} - ${formatTime(item?.end_time)}`
}

export default function VideoAnalysisPanel({ analysis, currentTime, onSeek, onClose }) {
  const timeline = Array.isArray(analysis?.timeline) ? analysis.timeline : []
  const currentSegment = timeline.find(item => (
    currentTime >= Number(item.start_time || 0) &&
    currentTime <= Number(item.end_time || 0)
  ))
  const timelineItems = currentSegment
    ? [currentSegment, ...timeline.filter(item => item !== currentSegment)].slice(0, 5)
    : timeline.slice(0, 5)
  const tags = Array.isArray(analysis?.tags) ? analysis.tags.slice(0, 5) : []
  const characters = Array.isArray(analysis?.characters) ? analysis.characters : []
  const analyzedCount = timeline.filter(item => item.vlm_status === 'analyzed').length

  return (
    <div className="player-analysis-panel" onClick={event => event.stopPropagation()}>
      <div className="player-analysis-head">
        <div>
          <p className="player-analysis-kicker">视频理解</p>
          <h3>{analysis?.naming?.episode_title || analysis?.sourceVideo?.original_filename || '分析结果'}</h3>
        </div>
        <button className="player-analysis-close" type="button" onClick={onClose} title="关闭" aria-label="关闭视频理解">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {analysis?.summary ? (
        <p className="player-analysis-summary">{analysis.summary}</p>
      ) : null}

      <div className="player-analysis-meta">
        <span>{timeline.length} 段</span>
        <span>{analyzedCount} 段已视觉分析</span>
        <span>{characters.length} 个人物</span>
      </div>

      {tags.length ? (
        <div className="player-analysis-tags">
          {tags.map(tag => <span key={tag}>{tag}</span>)}
        </div>
      ) : null}

      {timelineItems.length ? (
        <div className="player-analysis-timeline">
          {timelineItems.map((item, index) => {
            const isActive = item === currentSegment
            return (
              <button
                key={`${item.start_time}-${index}`}
                className={isActive ? 'active' : ''}
                type="button"
                onClick={() => onSeek?.(Number(item.start_time) || 0)}
              >
                <span className="player-analysis-time">{formatTime(item.start_time)}</span>
                <span className="player-analysis-line">
                  <strong>{getTimelineTitle(item)}</strong>
                  {item.description ? <small>{item.description}</small> : null}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
