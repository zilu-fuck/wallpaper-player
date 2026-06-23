export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SUBTITLE_SCALE_OPTIONS = [0.75, 1, 1.25, 1.5, 2]

export function formatSpeed(value) {
  const speed = Number(value)
  if (!Number.isFinite(speed)) return '1x'
  return `${speed.toFixed(speed % 1 ? 2 : 0)}x`
}

function getTrackLabel(track, fallback) {
  if (!track) return fallback
  const parts = [track.title, track.lang, track.external ? '外部' : ''].filter(Boolean)
  return parts.length ? parts.join(' / ') : fallback
}

export default function PlayerToolbarMenu({
  activeMenu,
  speed,
  subtitleId,
  subtitleScale,
  subtitleVisible,
  audioId,
  canUseMpv,
  subtitleTracks,
  audioTracks,
  onClose,
  onSpeedChange,
  onSelectSubtitle,
  onSubtitleScaleChange,
  onToggleSubtitleVisible,
  onSelectAudio
}) {
  if (activeMenu === 'quality') {
    return (
      <div className="player-menu player-menu-right" role="menu">
        <button className="active" type="button" role="menuitem" onClick={onClose}>原画</button>
        <span className="player-menu-note">本地文件暂无多清晰度源</span>
      </div>
    )
  }

  if (activeMenu === 'speed') {
    return (
      <div className="player-menu player-menu-right" role="menu">
        {SPEED_OPTIONS.map(option => (
          <button
            key={option}
            className={Math.abs(speed - option) < 0.01 ? 'active' : ''}
            type="button"
            role="menuitem"
            onClick={() => onSpeedChange(option)}
          >
            {formatSpeed(option)}
          </button>
        ))}
      </div>
    )
  }

  if (activeMenu === 'subtitle') {
    return (
      <div className="player-menu player-menu-right" role="menu">
        <button className={subtitleId == null ? 'active' : ''} type="button" role="menuitem" onClick={() => onSelectSubtitle('no')}>关闭字幕</button>
        {canUseMpv && subtitleTracks.length ? subtitleTracks.map(track => (
          <button
            key={track.id}
            className={subtitleId === Number(track.id) ? 'active' : ''}
            type="button"
            role="menuitem"
            onClick={() => onSelectSubtitle(track.id)}
          >
            {getTrackLabel(track, `字幕 ${track.id}`)}
          </button>
        )) : (
          <span className="player-menu-note">没有检测到字幕轨</span>
        )}
      </div>
    )
  }

  if (activeMenu === 'settings') {
    return (
      <div className="player-menu player-menu-right player-settings-menu" role="menu">
        <div className="player-menu-group">
          <span className="player-menu-title">字幕大小</span>
          <div className="player-menu-options">
            {SUBTITLE_SCALE_OPTIONS.map(option => (
              <button
                key={option}
                className={Math.abs(subtitleScale - option) < 0.01 ? 'active' : ''}
                type="button"
                role="menuitem"
                onClick={() => onSubtitleScaleChange(option)}
              >
                {Math.round(option * 100)}%
              </button>
            ))}
          </div>
        </div>
        <button type="button" role="menuitem" onClick={onToggleSubtitleVisible}>
          {subtitleVisible ? '隐藏字幕' : '显示字幕'}
        </button>
        <div className="player-menu-group">
          <span className="player-menu-title">音轨</span>
          {canUseMpv && audioTracks.length ? audioTracks.map(track => (
            <button
              key={track.id}
              className={audioId === Number(track.id) ? 'active' : ''}
              type="button"
              role="menuitem"
              onClick={() => onSelectAudio(track.id)}
            >
              {getTrackLabel(track, `音轨 ${track.id}`)}
            </button>
          )) : (
            <span className="player-menu-note">没有可切换音轨</span>
          )}
        </div>
      </div>
    )
  }

  return null
}
