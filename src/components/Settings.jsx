import { memo, useState, useCallback, useEffect, useRef } from 'react'
import { WINDOW_EVENTS } from '../api/events'
import { useAppFields } from '../context/AppContext'
import SettingsHeader from './settings/SettingsHeader'
import SettingsFooter from './settings/SettingsFooter'
import { AppearanceSection, PlaybackModeSection, WindowCloseSection } from './settings/BasicSettingsSections'
import PluginManagementPage from './settings/PluginManagementPage'
import {
  AboutSection,
  DownloadStatusSection,
  FfmpegStatusSection,
  MpvStatusSection,
  ShortcutsSection,
  UpdateSection
} from './settings/StatusSettingsSections'
import VideoAnalysisPluginSettings from './settings/VideoAnalysisPluginSettings'
import RemoteAccessSection from './settings/RemoteAccessSection'
import { useMpvInstaller } from '../hooks/useMpvInstaller'
import { useVideoAnalysisSettings } from '../hooks/useVideoAnalysisSettings'
import { usePluginSettings } from '../hooks/usePluginSettings'
import { useDownloadStateObserver } from '../hooks/useDownloadStateObserver'

const SETTINGS_PAGES = [
  { id: 'basic', label: '基础设置', desc: '外观与播放' },
  { id: 'remote', label: '手机访问', desc: '局域网与设备' },
  { id: 'plugins', label: '插件管理', desc: '官方与第三方' },
  { id: 'system', label: '系统状态', desc: '依赖与关于' }
]

function Settings({ initialPage = '' }) {
  const {
    settings,
    plugins,
    pluginsLoaded,
    refreshPlugins,
    ffmpegStatus,
    mpvStatus,
    setMpvStatus,
    saveSettings,
    settingsSaveError,
    handleThemeChange,
    playbackMode,
    handlePlaybackModeChange: savePlaybackMode,
    handleCheckUpdate,
    setShowSettings,
    availableTags
  } = useAppFields([
    'settings', 'plugins', 'pluginsLoaded',
    'refreshPlugins', 'ffmpegStatus', 'mpvStatus',
    'setMpvStatus', 'saveSettings', 'handleThemeChange', 'playbackMode',
    'handlePlaybackModeChange', 'handleCheckUpdate', 'setShowSettings', 'availableTags', 'settingsSaveError'
  ])

  const theme = settings?.theme || 'dark'
  const { downloading, downloadProgress, mpvDownloadError, download: handleDownloadMpv, cancel: cancelDownloadMpv } = useMpvInstaller(setMpvStatus)
  const [downloadStateLoading, setDownloadStateLoading] = useState(false)
  const [downloadStateMessage, setDownloadStateMessage] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [activePage, setActivePage] = useState(initialPage || 'basic')
  const pluginSettings = usePluginSettings({ plugins, refreshPlugins, active: activePage === 'plugins' })
  const { activePluginId } = pluginSettings
  const overlayRef = useRef(null)
  const panelRef = useRef(null)
  const restoreFocusRef = useRef(document.activeElement)
  const onClose = useCallback(() => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && overlayRef.current?.contains(activeElement)) {
      activeElement.blur()
    }
    setShowSettings(false)
  }, [setShowSettings])
  const windowCloseMode = settings?.windowClose?.mode || 'ask'
  const closeWithoutPrompt = windowCloseMode !== 'ask'
  const videoAnalysisPlugin = plugins.find(plugin => plugin.id === 'video-analysis')
  const videoAnalysisPluginEnabled = Boolean(pluginsLoaded && videoAnalysisPlugin?.enabled)
  const analysisSettings = useVideoAnalysisSettings({ enabled: videoAnalysisPluginEnabled,
    active: activePage === 'plugins' && activePluginId === 'video-analysis' && Boolean(settings?.videoAnalysis?.enabled),
    settings: settings?.videoAnalysis })
  const downloadError = useCallback(message => setDownloadStateMessage(message), [])
  const { state: downloadState, refreshState: refreshDownloads } = useDownloadStateObserver(downloadError, { active: activePage === 'system' })

  useEffect(() => {
    const overlay = overlayRef.current
    const panel = panelRef.current
    if (!overlay || !panel) return undefined

    const siblings = Array.from(overlay.parentElement?.children || []).filter(node => node !== overlay)
    const previousInert = siblings.map(node => node.inert)
    siblings.forEach(node => { node.inert = true })

    const getFocusable = () => Array.from(panel.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )).filter(node => !node.closest('[inert]'))

    getFocusable()[0]?.focus()
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      siblings.forEach((node, index) => { node.inert = previousInert[index] })
      restoreFocusRef.current?.focus?.()
    }
  }, [onClose])

  useEffect(() => {
    let mounted = true
    window.electronAPI.getAppVersion?.().then(version => { if (mounted) setAppVersion(version || '') }).catch(() => {})
    return () => { mounted = false }
  }, [])

  const handleChangeTheme = useCallback(async (nextTheme) => {
    try { await handleThemeChange(nextTheme) } catch { /* AppState publishes the current save error. */ }
  }, [handleThemeChange])
  const handlePlaybackModeChange = useCallback(async nextMode => {
    try { await savePlaybackMode(nextMode) } catch { /* Keep React event handlers settled. */ }
  }, [savePlaybackMode])

  const handleWindowCloseModeChange = useCallback(async (mode) => {
    try { await saveSettings({
      windowClose: {
        mode,
        rememberedAction: '',
        rememberedDate: ''
      }
    }) } catch { /* AppState rolls back only this intent. */ }
  }, [saveSettings])

  const handleVideoAnalysisToggle = useCallback(async (enabled) => {
    try { await saveSettings({
      videoAnalysis: { enabled }
    }) } catch { /* This panel also displays the shared save error. */ }
  }, [saveSettings])

  const handleSelectMpvPath = useCallback(async () => {
    cancelDownloadMpv()
    const mpvPath = await window.electronAPI.selectMpvPath()
    if (mpvPath) {
      await saveSettings({ mpvPath })
      const status = await window.electronAPI.checkMpv()
      setMpvStatus(status)
    }
  }, [cancelDownloadMpv, saveSettings, setMpvStatus])

  const handleRefreshDownloadState = useCallback(async () => {
    setDownloadStateLoading(true)
    setDownloadStateMessage('')
    try {
      const result = await refreshDownloads({ refresh: true })
      if (result?.success) {
        setDownloadStateMessage('下载引擎状态已刷新')
      } else {
        setDownloadStateMessage(result?.error || '读取下载中心状态失败')
      }
    } catch (err) {
      setDownloadStateMessage(err?.message || '读取下载中心状态失败')
    } finally {
      setDownloadStateLoading(false)
      setTimeout(() => setDownloadStateMessage(''), 2200)
    }
  }, [refreshDownloads])

  const handleOpenDownloadCenter = useCallback(() => {
    window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.OPEN_DOWNLOAD_CENTER, {
      detail: { type: 'open' }
    }))
    onClose()
  }, [onClose])

  const videoAnalysisEnabled = Boolean(settings?.videoAnalysis?.enabled)
  const videoAnalysisSettings = (
    <VideoAnalysisPluginSettings {...analysisSettings}
      enabled={videoAnalysisEnabled} pluginEnabled={videoAnalysisPluginEnabled} onToggle={handleVideoAnalysisToggle} />
  )

  return (
    <div ref={overlayRef} className="settings-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
      >
        <SettingsHeader onClose={onClose} />
        {settingsSaveError ? <p className="settings-warning" role="alert" style={{ margin: '0 24px 12px' }}>设置保存失败：{settingsSaveError}</p> : null}

        <div className="settings-body settings-layout">
          <aside className="settings-sidebar" aria-label="设置分页">
            {SETTINGS_PAGES.map((page) => (
              <button
                key={page.id}
                className={`settings-nav-item${activePage === page.id ? ' active' : ''}`}
                type="button"
                onClick={() => setActivePage(page.id)}
              >
                <span>{page.label}</span>
                <small>{page.desc}</small>
              </button>
            ))}
          </aside>

          <div className="settings-page">
            {activePage === 'basic' ? (
              <>
                <AppearanceSection theme={theme} onThemeChange={handleChangeTheme} />
                <PlaybackModeSection playbackMode={playbackMode} onPlaybackModeChange={handlePlaybackModeChange} />
                <WindowCloseSection
                  windowCloseMode={windowCloseMode}
                  closeWithoutPrompt={closeWithoutPrompt}
                  onModeChange={handleWindowCloseModeChange}
                />
              </>
            ) : null}

            {activePage === 'remote' ? (
              <RemoteAccessSection settings={settings} />
            ) : null}

            {activePage === 'plugins' ? (
              <PluginManagementPage
                plugins={plugins}
                {...pluginSettings}
                availableTags={availableTags}
                videoAnalysisSettings={videoAnalysisSettings}
              />
            ) : null}

            {activePage === 'system' ? (
              <>
                <UpdateSection onCheckUpdate={handleCheckUpdate} />
                <DownloadStatusSection
                  downloadState={downloadState}
                  downloadLoading={downloadStateLoading}
                  downloadMessage={downloadStateMessage}
                  onRefreshDownloadState={handleRefreshDownloadState}
                  onOpenDownloadCenter={handleOpenDownloadCenter}
                />
                <MpvStatusSection
                  mpvStatus={mpvStatus}
                  downloading={downloading}
                  downloadProgress={downloadProgress}
                  mpvDownloadError={mpvDownloadError}
                  onDownloadMpv={handleDownloadMpv}
                  onCancelDownloadMpv={cancelDownloadMpv}
                  onSelectMpvPath={handleSelectMpvPath}
                />
                <FfmpegStatusSection ffmpegStatus={ffmpegStatus} />
                <AboutSection appVersion={appVersion} />
                <ShortcutsSection />
              </>
            ) : null}
          </div>
        </div>

        <SettingsFooter appVersion={appVersion} onClose={onClose} />
      </div>
    </div>
  )
}

export default memo(Settings)
