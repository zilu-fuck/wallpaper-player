import { useEffect, useState } from 'react'
import AiSearchPluginSettings from './AiSearchPluginSettings'

function getStatusLabel(plugin) {
  if (!plugin) return ''
  if (plugin.status === 'planned') return '规划中'
  if (plugin.status === 'error') return '异常'
  return plugin.enabled ? '已启用' : '已停用'
}

function getStatusClass(plugin) {
  if (!plugin) return ''
  if (plugin.status === 'planned') return ' planned'
  if (plugin.status === 'error') return ' error'
  return plugin.enabled ? ' active' : ' disabled'
}

function getPluginSummary(plugin) {
  if (!plugin) return ''
  if (plugin.status === 'planned') return '等待后续版本接入'
  if (plugin.status === 'error') return plugin.lastError || '加载失败'
  return plugin.enabled ? '生命周期已加载' : '生命周期已卸载'
}

function getSourceLabel(plugin) {
  if (!plugin) return ''
  return plugin.publisher === 'official' || plugin.official ? '官方插件' : '第三方插件'
}

function getLifecycleAction(plugin) {
  if (!plugin) return { enabled: false, label: '' }
  if (plugin.status === 'error' && !plugin.enabled) {
    return { enabled: true, label: '重试启用', className: ' btn-primary' }
  }
  return {
    enabled: !plugin.enabled,
    label: plugin.enabled ? '停用插件' : '启用插件',
    className: plugin.enabled ? ' btn-danger' : ' btn-primary'
  }
}

function getPermissionLabel(permission) {
  const labels = {
    'agent:commands': 'Agent 命令',
    'background:jobs': '后台任务',
    'model-services:manage': '模型服务管理',
    'player:control': '控制播放器',
    'remote:routes': '注册远程路由',
    'settings:readwrite': '读写设置',
    'video:read': '读取视频文件',
    'video:index:read': '读取视频索引',
    'video-analysis:read': '读取分析摘要',
    'video-analysis:start': '触发视频分析'
  }
  return labels[permission] || permission
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function formatConfigDraft(field, value) {
  if (field?.type === 'object') {
    if (typeof value === 'string') return value
    return JSON.stringify(isPlainObject(value) ? value : {}, null, 2)
  }
  if (value == null) return ''
  return String(value)
}

function parseConfigDraft(field, value) {
  if (field?.type === 'number') {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
  }
  if (field?.type === 'object') {
    if (isPlainObject(value)) return value
    const parsed = JSON.parse(value || '{}')
    if (!isPlainObject(parsed)) throw new Error('JSON 必须是对象')
    return parsed
  }
  return value
}

function buildConfigDrafts(plugin, schemaKeys, settingsSchema) {
  return Object.fromEntries(
    schemaKeys.map(key => [
      key,
      formatConfigDraft(settingsSchema[key], plugin?.config?.[key])
    ])
  )
}

function hasDraftChanges(plugin, schemaKeys, settingsSchema, drafts) {
  return schemaKeys.some(key => (
    formatConfigDraft(settingsSchema[key], plugin?.config?.[key]) !== formatConfigDraft(settingsSchema[key], drafts[key])
  ))
}

function renderConfigInput({
  plugin,
  key,
  field,
  value,
  draftValue,
  error,
  busy,
  onDraftChange,
  onCommit
}) {
  const disabled = Boolean(busy)

  if (field?.type === 'boolean') {
    return (
      <label className="plugin-config-toggle" key={key}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onCommit(key, event.target.checked, true)}
          disabled={disabled}
        />
        <span>{field.title || key}</span>
      </label>
    )
  }

  if (field?.type === 'enum' && Array.isArray(field.enum)) {
    return (
      <label className="plugin-config-field" key={key}>
        <span>{field.title || key}</span>
        <select value={value ?? ''} onChange={(event) => onCommit(key, event.target.value, true)} disabled={disabled}>
          {field.enum.map(option => <option key={String(option)} value={option}>{String(option)}</option>)}
        </select>
      </label>
    )
  }

  if (field?.type === 'object') {
    return (
      <label className="plugin-config-field plugin-config-field-wide" key={key}>
        <span>{field.title || key}</span>
        <textarea
          value={draftValue ?? '{}'}
          onChange={(event) => onDraftChange(key, event.target.value)}
          disabled={disabled}
          spellCheck={false}
        />
        {error ? <small className="error">{error}</small> : null}
        {!error && field?.description ? <small>{field.description}</small> : null}
      </label>
    )
  }

  return (
    <label className="plugin-config-field" key={key}>
      <span>{field?.title || key}</span>
      <input
        type={field?.type === 'number' ? 'number' : 'text'}
        value={draftValue ?? ''}
        onChange={(event) => onDraftChange(key, event.target.value)}
        disabled={disabled}
      />
      {error ? <small className="error">{error}</small> : null}
      {field?.description ? <small>{field.description}</small> : null}
    </label>
  )
}

export default function PluginManagementPage({
  plugins,
  activePluginId,
  onSelectPlugin,
  onTogglePlugin,
  onInstallPluginFile,
  onInstallPluginDirectory,
  onUninstallPlugin,
  onOpenPluginsDirectory,
  onSavePluginConfig,
  busyPluginId,
  message,
  availableTags,
  videoAnalysisSettings
}) {
  const activePlugin = plugins.find(plugin => plugin.id === activePluginId) || plugins[0] || null
  const permissions = Array.isArray(activePlugin?.permissions) ? activePlugin.permissions : []
  const settingsSchema = activePlugin?.settingsSchema && typeof activePlugin.settingsSchema === 'object'
    ? activePlugin.settingsSchema
    : {}
  const schemaKeys = Object.keys(settingsSchema)
  const remoteRoutes = Array.isArray(activePlugin?.contributions?.remoteRoutes)
    ? activePlugin.contributions.remoteRoutes
    : []
  const canToggle = Boolean(activePlugin?.canEnable)
  const installingFile = busyPluginId === 'install-file'
  const installingDirectory = busyPluginId === 'install-directory'
  const installing = installingFile || installingDirectory
  const busy = busyPluginId === activePlugin?.id
  const actionBusy = busy || installing
  const lifecycleAction = getLifecycleAction(activePlugin)
  const [configDrafts, setConfigDrafts] = useState({})
  const [configErrors, setConfigErrors] = useState({})
  const draftChanged = activePlugin
    ? hasDraftChanges(activePlugin, schemaKeys, settingsSchema, configDrafts)
    : false

  useEffect(() => {
    setConfigDrafts(buildConfigDrafts(activePlugin, schemaKeys, settingsSchema))
    setConfigErrors({})
  }, [activePlugin?.id, activePlugin?.updatedAt])

  const handleDraftChange = (key, value) => {
    setConfigDrafts(prev => ({ ...prev, [key]: value }))
    setConfigErrors(prev => ({ ...prev, [key]: '' }))
  }

  const handleCommitConfig = (key, immediateValue, hasImmediateValue = false) => {
    if (!activePlugin) return
    const field = settingsSchema[key]
    try {
      const nextValue = hasImmediateValue
        ? immediateValue
        : parseConfigDraft(field, configDrafts[key])
      setConfigErrors(prev => ({ ...prev, [key]: '' }))
      onSavePluginConfig(activePlugin.id, {
        ...(activePlugin.config || {}),
        [key]: nextValue
      })
    } catch (error) {
      setConfigErrors(prev => ({ ...prev, [key]: error?.message || '配置格式无效' }))
    }
  }

  const handleSaveDraftConfig = () => {
    if (!activePlugin) return
    const nextConfig = { ...(activePlugin.config || {}) }
    const nextErrors = {}
    for (const key of schemaKeys) {
      const field = settingsSchema[key]
      if (field?.type === 'boolean' || field?.type === 'enum') continue
      try {
        nextConfig[key] = parseConfigDraft(field, configDrafts[key])
      } catch (error) {
        nextErrors[key] = error?.message || '配置格式无效'
      }
    }
    setConfigErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    onSavePluginConfig(activePlugin.id, nextConfig)
  }

  return (
    <div className="plugin-management">
      <div className="plugin-list" aria-label="插件列表">
        <div className="plugin-list-head">
          <strong>插件</strong>
          <span>{plugins.length} 个插件</span>
        </div>
        <div className="plugin-list-actions">
          <button className="btn btn-sm btn-primary" type="button" onClick={onInstallPluginFile} disabled={installing}>
            {installingFile ? '安装中...' : '安装包'}
          </button>
          <button className="btn btn-sm" type="button" onClick={onInstallPluginDirectory} disabled={installing}>
            {installingDirectory ? '安装中...' : '安装文件夹'}
          </button>
          <button className="btn btn-sm plugin-list-open-dir" type="button" onClick={onOpenPluginsDirectory} disabled={installing}>
            打开插件目录
          </button>
        </div>
        {plugins.length ? plugins.map((plugin) => (
          <button
            className={`plugin-list-item${plugin.id === activePlugin?.id ? ' selected' : ''}`}
            key={plugin.id}
            type="button"
            onClick={() => onSelectPlugin(plugin.id)}
          >
            <span className="plugin-list-name">{plugin.name}</span>
            <span className={`plugin-status${getStatusClass(plugin)}`}>{getStatusLabel(plugin)}</span>
            <small>{getSourceLabel(plugin)} · {getPluginSummary(plugin)}</small>
          </button>
        )) : (
          <p className="hint plugin-empty">正在读取插件注册表...</p>
        )}
      </div>

      <section className="plugin-detail">
        {activePlugin ? (
          <>
            <div className="plugin-detail-header">
              <div>
                <span className="plugin-detail-kicker">{getSourceLabel(activePlugin)}</span>
                <h3>{activePlugin.name}</h3>
                <p>{activePlugin.description || '暂无插件说明。'}</p>
              </div>
              <span className={`plugin-status${getStatusClass(activePlugin)}`}>{getStatusLabel(activePlugin)}</span>
            </div>

            <div className="plugin-lifecycle-row">
              <div>
                <strong>生命周期</strong>
                <span>{getPluginSummary(activePlugin)}</span>
              </div>
              <div className="plugin-lifecycle-actions">
                <button
                  className={`btn btn-sm${lifecycleAction.className || ''}`}
                  type="button"
                  onClick={() => onTogglePlugin(activePlugin.id, lifecycleAction.enabled)}
                  disabled={!canToggle || actionBusy}
                >
                  {busy ? '处理中...' : lifecycleAction.label}
                </button>
                {activePlugin.uninstallable ? (
                  <button
                    className="btn btn-sm btn-danger"
                    type="button"
                    onClick={() => onUninstallPlugin(activePlugin.id)}
                    disabled={actionBusy}
                  >
                    卸载插件
                  </button>
                ) : null}
              </div>
            </div>

            {activePlugin.lastError ? (
              <p className="hint error plugin-message">{activePlugin.lastError}</p>
            ) : null}
            {message ? <p className="hint plugin-message">{message}</p> : null}

            <div className="plugin-info-grid">
              <div className="plugin-info-box">
                <strong>来源</strong>
                <p className="hint">
                  {activePlugin.publisher === 'official' || activePlugin.official
                    ? '由应用创作者维护，和第三方插件使用同一套注册、启停和设置机制。'
                    : '由第三方安装，默认按声明式能力运行，不开放任意文件或进程权限。'}
                </p>
                {activePlugin.author ? <p className="hint">作者：{activePlugin.author}</p> : null}
                {activePlugin.installedAt ? <p className="hint">安装：{new Date(activePlugin.installedAt).toLocaleString()}</p> : null}
                {activePlugin.updatedAt ? <p className="hint">更新：{new Date(activePlugin.updatedAt).toLocaleString()}</p> : null}
                {activePlugin.location ? <p className="hint plugin-path">{activePlugin.location}</p> : null}
              </div>
              <div className="plugin-info-box">
                <strong>权限</strong>
                {permissions.length ? (
                  <div className="plugin-chip-list">
                    {permissions.map(permission => <span key={permission}>{getPermissionLabel(permission)}</span>)}
                  </div>
                ) : (
                  <p className="hint">没有声明额外权限。</p>
                )}
              </div>
              <div className="plugin-info-box">
                <strong>设置 Schema</strong>
                {schemaKeys.length ? (
                  <div className="plugin-chip-list">
                    {schemaKeys.map(key => <span key={key}>{settingsSchema[key]?.title || key}</span>)}
                  </div>
                ) : (
                  <p className="hint">当前插件没有暴露设置 schema。</p>
                )}
              </div>
              <div className="plugin-info-box">
                <strong>远程路由</strong>
                {remoteRoutes.length ? (
                  <div className="plugin-chip-list">
                    {remoteRoutes.map(route => (
                      <span key={`${route.method}:${route.routePattern || route.pattern}`}>
                        {route.method} {route.routePattern || route.pattern}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="hint">没有声明远程路由。</p>
                )}
              </div>
            </div>

            {schemaKeys.length ? (
              activePlugin.id === 'ai-search' ? (
                <AiSearchPluginSettings
                  plugin={activePlugin}
                  configDrafts={configDrafts}
                  configErrors={configErrors}
                  busy={actionBusy}
                  onDraftChange={handleDraftChange}
                  onSaveDraftConfig={handleSaveDraftConfig}
                  onCommitConfig={handleCommitConfig}
                  draftChanged={draftChanged}
                  availableTags={availableTags}
                />
              ) : (
                <div className="plugin-config-panel">
                  <div className="plugin-config-heading">
                    <strong>插件配置</strong>
                    <button
                      className="btn btn-sm btn-primary"
                      type="button"
                      onClick={handleSaveDraftConfig}
                      disabled={actionBusy || !draftChanged}
                    >
                      {busy ? '保存中...' : '保存配置'}
                    </button>
                  </div>
                  <div className="plugin-config-grid">
                    {schemaKeys.map(key => renderConfigInput({
                      plugin: activePlugin,
                      key,
                      field: settingsSchema[key],
                      value: activePlugin.config?.[key],
                      draftValue: configDrafts[key],
                      error: configErrors[key],
                      busy: actionBusy,
                      onDraftChange: handleDraftChange,
                      onCommit: handleCommitConfig
                    }))}
                  </div>
                </div>
              )
            ) : null}

            {activePlugin.status === 'planned' ? (
              <div className="plugin-planned-note">
                <strong>规划方向</strong>
                <p>
                  该插件只在注册表中占位，后续会按受控能力接入，不开放任意文件或进程权限。
                </p>
              </div>
            ) : null}

            {activePlugin.id === 'video-analysis' ? videoAnalysisSettings : null}
          </>
        ) : (
          <p className="hint plugin-empty">插件注册表暂时为空。</p>
        )}
      </section>
    </div>
  )
}
