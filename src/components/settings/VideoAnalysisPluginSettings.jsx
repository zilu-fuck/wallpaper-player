function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '大小未知'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(value / 1024)} KB`
}

export default function VideoAnalysisPluginSettings({
  enabled,
  pluginEnabled,
  analysisOutputDir,
  analysisModelDir,
  defaultAnalysisModelDir,
  analysisOutputMessage,
  analysisModelMessage,
  analysisRuntimeConfig,
  analysisConfigSaving,
  analysisConfigMessage,
  vlmState,
  vlmSaving,
  vlmMessage,
  vlmModelOptions,
  selectedVlmModelId,
  selectedVlmPrecision,
  localVlmFiles,
  localVlmLoading,
  onToggle,
  onSelectAnalysisOutputDir,
  onOpenAnalysisOutputDir,
  onSelectAnalysisModelDir,
  onOpenAnalysisModelDir,
  onVlmRuntimeChange,
  onSelectedVlmModelChange,
  onSelectedVlmPrecisionChange,
  onSaveVlmConfig,
  onDownloadVlmModel,
  onStartVlmService,
  onStopVlmService,
  onRefreshVlmState,
  onSelectVlmModelFile,
  onListLocalVlmFiles,
  onSelectLocalVlmFile,
  onSelectVlmServerExecutable,
  onAnalysisRuntimeChange,
  onLlmProviderChange,
  onSaveAnalysisRuntimeConfig,
  onResetAnalysisRuntimeConfig
}) {
  const currentVlmModelOption = vlmModelOptions.models?.find(item => item.id === selectedVlmModelId)
  const availableVlmPrecisions = currentVlmModelOption?.precisions?.length
    ? currentVlmModelOption.precisions
    : (vlmModelOptions.precisions || []).map(item => item.id)
  const visibleVlmPrecisions = (vlmModelOptions.precisions || [])
    .filter(item => availableVlmPrecisions.includes(item.id))
  const vlmDownloadProgress = vlmState?.download
  const vlmDownloadPercent = Math.max(0, Math.min(100, Number(vlmDownloadProgress?.percent) || 0))
  const vlmDownloadInfo = vlmDownloadProgress
    ? `${vlmDownloadPercent}% · ${formatBytes(vlmDownloadProgress.transferred)} / ${formatBytes(vlmDownloadProgress.total)}`
    : ''
  const vlmProviderIsApi = analysisRuntimeConfig.vlmProvider === 'api'
  const vlmStatusText = vlmState?.connected ? '已连接' : (vlmState?.running ? '服务运行中' : '未连接')
  const vlmModelFileName = analysisRuntimeConfig.vlmModelPath
    ? analysisRuntimeConfig.vlmModelPath.split(/[\\/]/).filter(Boolean).pop()
    : analysisRuntimeConfig.vlmName
  const vlmModelDirectory = `${analysisModelDir || defaultAnalysisModelDir || '当前模型目录'}\\vlm`
  const vlmModelStateText = vlmProviderIsApi
    ? '外接 API'
    : (vlmState?.downloading ? '下载中' : (vlmState?.modelExists ? '已找到' : '未找到'))

  return (
    <section className="settings-section plugin-settings-section">
      <h3 className="section-title">视频理解设置</h3>
      <p className="section-desc">控制结果面板、分析目录、本地 VLM 服务和文本模型参数。</p>
      <label className="remote-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onToggle(event.target.checked)}
          disabled={!pluginEnabled}
        />
        <span>启用视频理解结果面板</span>
      </label>
      <p className="hint video-analysis-settings-hint">
        {!pluginEnabled
          ? '插件停用后已卸载视频理解 IPC 和远程路由，请先启用插件。'
          : (enabled
              ? '结果来自下方分析结果保存目录；没有匹配结果的视频会保持原播放界面。'
              : '开启后可从视频卡片菜单发起分析，并在播放器里查看已生成结果。')}
      </p>
      {pluginEnabled && enabled ? (
        <div className="analysis-settings-expanded">
          <div className="analysis-settings-group">
            <div className="analysis-settings-group-header">
              <strong>目录</strong>
              <span>分析结果、本地模型和下载位置</span>
            </div>
            <div className="analysis-output-settings">
              <span title={analysisOutputDir}>{analysisOutputDir || '使用默认保存目录'}</span>
              <button className="btn btn-sm" type="button" onClick={onSelectAnalysisOutputDir}>
                选择目录
              </button>
              <button className="btn btn-sm" type="button" onClick={onOpenAnalysisOutputDir}>
                打开目录
              </button>
            </div>
            <p className="hint video-analysis-settings-hint">
              新完成的分析会保存为“视频名分析结果-识别码.json”，同一个视频会覆盖自己的旧结果。{analysisOutputMessage ? ` ${analysisOutputMessage}` : ''}
            </p>
            <div className="analysis-output-settings">
              <span title={analysisModelDir}>{analysisModelDir || '使用默认模型目录'}</span>
              <button className="btn btn-sm" type="button" onClick={onSelectAnalysisModelDir}>
                选择目录
              </button>
              <button className="btn btn-sm" type="button" onClick={onOpenAnalysisModelDir}>
                打开目录
              </button>
            </div>
            <p className="hint video-analysis-settings-hint">
              推荐模型目录：{defaultAnalysisModelDir || '正在读取默认目录'}。当前使用目录：{analysisModelDir || defaultAnalysisModelDir || '正在读取模型目录'}。下载的 VLM 会保存到当前目录下的 vlm 子文件夹；从别处下载的模型也建议放到这个 vlm 子文件夹里，点击“检测目录模型”即可识别。{analysisModelMessage ? ` ${analysisModelMessage}` : ''}
            </p>
          </div>
          <div className="analysis-vlm-panel">
            <div className="analysis-vlm-header">
              <div>
                <strong>视觉模型</strong>
                <p>选择模型后点击“启动模型”，会先保存配置再启动本地服务。</p>
              </div>
              <span className={`analysis-vlm-status${vlmState?.connected ? ' connected' : ''}`}>
                {vlmStatusText}
              </span>
            </div>
            <div className="analysis-vlm-quick-card">
              <div className="analysis-vlm-quick-grid">
                <div>
                  <span>当前模型</span>
                  <strong title={analysisRuntimeConfig.vlmModelPath || analysisRuntimeConfig.vlmName}>
                    {vlmProviderIsApi ? (analysisRuntimeConfig.vlmName || '未填写模型名称') : (vlmModelFileName || '未选择模型文件')}
                  </strong>
                </div>
                <div>
                  <span>模型状态</span>
                  <strong>{vlmModelStateText}</strong>
                </div>
                <div>
                  <span>连接地址</span>
                  <strong title={analysisRuntimeConfig.vlmBaseUrl}>{analysisRuntimeConfig.vlmBaseUrl || '未填写'}</strong>
                </div>
              </div>
              <div className="analysis-vlm-quick-actions">
                {vlmProviderIsApi ? (
                  <button className="btn btn-sm btn-primary" type="button" onClick={onRefreshVlmState}>
                    检测连接
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn-sm btn-primary analysis-vlm-start-button"
                      type="button"
                      onClick={onStartVlmService}
                      disabled={vlmState?.downloading || vlmSaving}
                    >
                      启动模型
                    </button>
                    <button className="btn btn-sm" type="button" onClick={onStopVlmService}>
                      停止服务
                    </button>
                    <button className="btn btn-sm" type="button" onClick={onRefreshVlmState}>
                      检测连接
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="analysis-provider-toggle" role="group" aria-label="视觉模型来源">
              <button
                className={`analysis-provider-option${analysisRuntimeConfig.vlmProvider !== 'api' ? ' active' : ''}`}
                type="button"
                onClick={() => onVlmRuntimeChange('vlmProvider', 'local')}
              >
                本地 VLM
              </button>
              <button
                className={`analysis-provider-option${analysisRuntimeConfig.vlmProvider === 'api' ? ' active' : ''}`}
                type="button"
                onClick={() => onVlmRuntimeChange('vlmProvider', 'api')}
              >
                外接 VLM API
              </button>
            </div>
            {vlmProviderIsApi ? (
              <div className="analysis-runtime-settings analysis-runtime-settings-clean">
                <label className="analysis-runtime-field wide">
                  <span>VLM API 地址</span>
                  <input
                    value={analysisRuntimeConfig.vlmBaseUrl}
                    onChange={(event) => onVlmRuntimeChange('vlmBaseUrl', event.target.value)}
                  />
                </label>
                <label className="analysis-runtime-field">
                  <span>VLM 模型名称</span>
                  <input
                    value={analysisRuntimeConfig.vlmName}
                    onChange={(event) => onVlmRuntimeChange('vlmName', event.target.value)}
                  />
                </label>
                <label className="analysis-runtime-field">
                  <span>VLM API Key</span>
                  <input
                    type="password"
                    value={analysisRuntimeConfig.vlmApiKey}
                    onChange={(event) => onVlmRuntimeChange('vlmApiKey', event.target.value)}
                  />
                </label>
              </div>
            ) : (
              <>
                <div className="analysis-runtime-settings analysis-runtime-settings-clean">
                  <label className="analysis-runtime-field wide">
                    <span>本地 VLM 服务地址</span>
                    <input
                      value={analysisRuntimeConfig.vlmBaseUrl}
                      onChange={(event) => onVlmRuntimeChange('vlmBaseUrl', event.target.value)}
                    />
                  </label>
                </div>
                <div className="analysis-vlm-download-box">
                  <label className="analysis-runtime-field">
                    <span>下载模型</span>
                    <select
                      value={selectedVlmModelId}
                      onChange={(event) => onSelectedVlmModelChange(event.target.value)}
                    >
                      {(vlmModelOptions.models || []).map((model) => (
                        <option value={model.id} key={model.id}>{model.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="analysis-runtime-field compact">
                    <span>精度</span>
                    <select
                      value={selectedVlmPrecision}
                      onChange={(event) => onSelectedVlmPrecisionChange(event.target.value)}
                    >
                      {visibleVlmPrecisions.map((precision) => (
                        <option value={precision.id} key={precision.id}>{precision.name}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={onDownloadVlmModel}
                    disabled={vlmState?.downloading || !selectedVlmModelId}
                  >
                    {vlmState?.downloading ? '下载中...' : '下载并配置'}
                  </button>
                  <div className="analysis-vlm-download-meta">
                    <span title={currentVlmModelOption?.repo || ''}>
                      {currentVlmModelOption?.repo || '请选择模型'}
                    </span>
                    {vlmDownloadProgress ? <strong>{vlmDownloadInfo}</strong> : null}
                  </div>
                  <p className="analysis-vlm-download-note">
                    下载位置：{vlmModelDirectory}。手动下载的 VLM 模型也可以放到这里再检测。
                  </p>
                  {vlmDownloadProgress ? (
                    <div className="analysis-vlm-progress" aria-label="VLM 模型下载进度">
                      <span style={{ width: `${vlmDownloadPercent}%` }} />
                    </div>
                  ) : null}
                </div>
                <div className="analysis-selected-model-card">
                  <div className="analysis-selected-model-info">
                    <span>本地模型文件</span>
                    <strong title={analysisRuntimeConfig.vlmModelPath || ''}>
                      {vlmModelFileName || '未选择模型文件'}
                    </strong>
                    <small title={analysisRuntimeConfig.vlmModelPath || vlmModelDirectory}>
                      {analysisRuntimeConfig.vlmModelPath || `推荐放在：${vlmModelDirectory}`}
                    </small>
                  </div>
                  <div className="analysis-selected-model-actions">
                    <button className="btn btn-sm" type="button" onClick={onSelectVlmModelFile}>
                      选择文件
                    </button>
                    <button className="btn btn-sm" type="button" onClick={onListLocalVlmFiles} disabled={localVlmLoading}>
                      {localVlmLoading ? '检测中...' : '检测目录模型'}
                    </button>
                  </div>
                </div>
                {localVlmFiles.length ? (
                  <div className="analysis-local-model-list">
                    <p className="analysis-local-model-summary">显示 {Math.min(localVlmFiles.length, 12)} / {localVlmFiles.length} 个本地模型</p>
                    {localVlmFiles.slice(0, 12).map((file) => (
                      <button
                        key={file.path}
                        className={`analysis-local-model-file${analysisRuntimeConfig.vlmModelPath === file.path ? ' active' : ''}`}
                        type="button"
                        onClick={() => onSelectLocalVlmFile(file.path)}
                        title={file.path}
                      >
                        <span>{file.name}</span>
                        <small>{formatBytes(file.size)}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
                <details className="analysis-detail-config">
                  <summary>更多配置</summary>
                  <div className="analysis-detail-body">
                    <label className="analysis-runtime-field wide">
                      <span>模型文件完整路径</span>
                      <div className="analysis-path-row">
                        <input
                          value={analysisRuntimeConfig.vlmModelPath}
                          onChange={(event) => onVlmRuntimeChange('vlmModelPath', event.target.value)}
                        />
                        <button className="btn btn-sm" type="button" onClick={onSelectVlmModelFile}>
                          选择
                        </button>
                      </div>
                    </label>
                    <label className="analysis-runtime-field">
                      <span>VLM 模型名称</span>
                      <input
                        value={analysisRuntimeConfig.vlmName}
                        onChange={(event) => onVlmRuntimeChange('vlmName', event.target.value)}
                      />
                    </label>
                    <label className="analysis-runtime-field">
                      <span>本地占位 API Key</span>
                      <input
                        type="password"
                        value={analysisRuntimeConfig.vlmApiKey}
                        onChange={(event) => onVlmRuntimeChange('vlmApiKey', event.target.value)}
                      />
                    </label>
                    <label className="analysis-runtime-field">
                      <span>HF Token（可选）</span>
                      <input
                        type="password"
                        value={analysisRuntimeConfig.vlmHfToken}
                        onChange={(event) => onVlmRuntimeChange('vlmHfToken', event.target.value)}
                      />
                    </label>
                    <label className="analysis-runtime-field wide">
                      <span>服务程序路径</span>
                      <div className="analysis-path-row">
                        <input
                          value={analysisRuntimeConfig.vlmServerExecutable}
                          onChange={(event) => onVlmRuntimeChange('vlmServerExecutable', event.target.value)}
                          placeholder="例如 C:\\llama.cpp\\llama-server.exe"
                        />
                        <button className="btn btn-sm" type="button" onClick={onSelectVlmServerExecutable}>
                          选择
                        </button>
                      </div>
                    </label>
                    <label className="analysis-runtime-field wide">
                      <span>启动参数</span>
                      <input
                        value={analysisRuntimeConfig.vlmServerArgs}
                        onChange={(event) => onVlmRuntimeChange('vlmServerArgs', event.target.value)}
                      />
                    </label>
                  </div>
                </details>
              </>
            )}
            <div className="analysis-vlm-footer">
              <button className="btn btn-sm" type="button" onClick={() => onSaveVlmConfig()} disabled={vlmSaving}>
                {vlmSaving ? '保存中...' : '保存设置'}
              </button>
              <p className="hint video-analysis-settings-hint">
                {vlmProviderIsApi
                  ? '外接 VLM API 保存后可直接检测连接。'
                  : '本地 VLM 使用项目自带的 llama.cpp 服务程序；启动参数可在“更多配置”中调整。'}
                {vlmMessage ? ` ${vlmMessage}` : ''}
              </p>
            </div>
          </div>
          <div className="analysis-settings-group">
            <div className="analysis-settings-group-header">
              <strong>分析参数</strong>
              <span>文本模型和运行策略</span>
            </div>
            <div className="analysis-provider-toggle" role="group" aria-label="文本模型来源">
              <button
                className={`analysis-provider-option${analysisRuntimeConfig.llmProvider !== 'api' ? ' active' : ''}`}
                type="button"
                onClick={() => onLlmProviderChange('local')}
              >
                本地文本模型
              </button>
              <button
                className={`analysis-provider-option${analysisRuntimeConfig.llmProvider === 'api' ? ' active' : ''}`}
                type="button"
                onClick={() => onLlmProviderChange('api')}
              >
                外接大模型 API
              </button>
            </div>
            <p className="hint video-analysis-settings-hint">
              {analysisRuntimeConfig.llmProvider === 'api'
                ? '文本理解会调用下方外部 OpenAI 兼容 API；视觉模型仍需要单独配置 VLM 服务。'
                : '默认使用子项目本地文本模型配置；请先启动本机 OpenAI 兼容文本模型服务。'}
            </p>
            <div className="analysis-runtime-settings">
              <label className="analysis-runtime-field compact">
                <span>分析质量</span>
                <select
                  value={analysisRuntimeConfig.mode}
                  onChange={(event) => onAnalysisRuntimeChange('mode', event.target.value)}
                >
                  <option value="fast">快速</option>
                  <option value="balance">平衡</option>
                  <option value="quantity">质量</option>
                </select>
              </label>
              <label className="analysis-runtime-field compact">
                <span>最大分析时长（秒）</span>
                <input
                  value={analysisRuntimeConfig.maxDurationSeconds}
                  onChange={(event) => onAnalysisRuntimeChange('maxDurationSeconds', event.target.value.replace(/[^\d]/g, ''))}
                  inputMode="numeric"
                />
              </label>
              <label className="analysis-runtime-field compact">
                <span>视觉分析并发数</span>
                <input
                  value={analysisRuntimeConfig.vlmConcurrency}
                  onChange={(event) => onAnalysisRuntimeChange('vlmConcurrency', event.target.value.replace(/[^\d]/g, ''))}
                  inputMode="numeric"
                />
              </label>
              <label className="analysis-runtime-field wide">
                <span>{analysisRuntimeConfig.llmProvider === 'api' ? '文本模型 API 地址' : '本地文本模型服务地址'}</span>
                <input
                  value={analysisRuntimeConfig.llmBaseUrl}
                  onChange={(event) => onAnalysisRuntimeChange('llmBaseUrl', event.target.value)}
                />
              </label>
              <label className="analysis-runtime-field">
                <span>{analysisRuntimeConfig.llmProvider === 'api' ? '外接文本模型名称' : '本地文本模型名称'}</span>
                <input
                  value={analysisRuntimeConfig.llmName}
                  onChange={(event) => onAnalysisRuntimeChange('llmName', event.target.value)}
                />
              </label>
              <label className="analysis-runtime-field">
                <span>文本模型 API Key</span>
                <input
                  type="password"
                  value={analysisRuntimeConfig.llmApiKey}
                  onChange={(event) => onAnalysisRuntimeChange('llmApiKey', event.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="mpv-actions">
            <button
              className="btn btn-sm btn-primary"
              type="button"
              onClick={onSaveAnalysisRuntimeConfig}
              disabled={analysisConfigSaving}
            >
              {analysisConfigSaving ? '保存中...' : '保存分析参数'}
            </button>
            <button
              className="btn btn-sm"
              type="button"
              onClick={onResetAnalysisRuntimeConfig}
              disabled={analysisConfigSaving}
            >
              恢复本地默认
            </button>
          </div>
          {analysisConfigMessage ? (
            <p className="hint video-analysis-settings-hint">{analysisConfigMessage}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
