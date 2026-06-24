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
  analysisRuntimeLoaded,
  analysisConfigSaving,
  analysisConfigMessage,
  vlmState,
  vlmSaving,
  vlmStarting,
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
  const currentAnalysisModelDir = analysisModelDir || defaultAnalysisModelDir || '当前模型目录'
  const vlmModelDirectory = `${currentAnalysisModelDir}\\vlm`
  const vlmModelStateText = vlmProviderIsApi
    ? '外接 API'
    : (vlmState?.downloading ? '下载中' : (vlmState?.modelExists ? '已找到' : '未找到'))

  return (
    <section className="settings-section plugin-settings-section">
      <h3 className="section-title">视频理解设置</h3>
      <p className="section-desc">普通用户只需要确认目录、准备视觉模型、点击启动模型；高级参数保持默认即可。</p>
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
              ? '已开启。播放器会读取下方“分析结果保存目录”里的结果；没有结果的视频仍按普通视频播放。'
              : '开启后，可从视频卡片菜单发起分析，并在播放器里查看已生成的摘要、标签和时间线。')}
      </p>
      {pluginEnabled && enabled ? (
        <div className="analysis-settings-expanded">
          <p className="hint video-analysis-settings-hint">
            最简单用法：保持默认目录，下载或选择一个 GGUF 视觉模型，点击“启动模型”，看到“已连接”后回到视频卡片发起分析。换电脑后如果显示“模型未找到”，把同名模型放到 {vlmModelDirectory}，再点“检测目录模型”。
          </p>
          <div className="analysis-settings-group">
            <div className="analysis-settings-group-header">
              <strong>目录</strong>
              <span>默认目录最稳；只有想放到别的磁盘时才需要改</span>
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
              这里保存分析结果 JSON。换电脑或重装后建议继续用默认目录；如果要保留旧结果，把旧 JSON 复制到这个目录即可。新分析会按“视频名分析结果-识别码.json”保存，同一个视频会覆盖自己的旧结果。{analysisOutputMessage ? ` ${analysisOutputMessage}` : ''}
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
              这里保存视觉模型，文件通常很大。推荐目录：{defaultAnalysisModelDir || '正在读取默认目录'}。当前使用目录：{currentAnalysisModelDir}。下载的模型会放到 {vlmModelDirectory}；从别处下载或从旧电脑复制来的模型，也放到这个 vlm 文件夹后点击“检测目录模型”。{analysisModelMessage ? ` ${analysisModelMessage}` : ''}
            </p>
          </div>
          <div className="analysis-vlm-panel">
            <div className="analysis-vlm-header">
              <div>
                <strong>视觉模型</strong>
                <p>本地模式会使用插件自带的服务程序；普通用户不用手动找 exe。</p>
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
                      disabled={!analysisRuntimeLoaded || vlmState?.downloading || vlmSaving || vlmStarting}
                    >
                      {!analysisRuntimeLoaded ? '读取配置...' : (vlmStarting ? '启动中...' : '启动模型')}
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
                <p className="hint video-analysis-settings-hint analysis-config-note">
                  只有你已经有可用的 OpenAI 兼容视觉 API 时才选这里。没有外部 API 时，请切回“本地 VLM”。
                </p>
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
                    <span>本地 VLM 服务地址（默认不用改）</span>
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
                    下载位置：{vlmModelDirectory}。手动下载或从旧电脑复制的 VLM 模型，也放到这里再检测。
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
                  <summary>高级配置（通常不用改）</summary>
                  <div className="analysis-detail-body">
                    <p className="hint video-analysis-settings-hint analysis-config-note">
                      下面这些是给手动接入 llama.cpp 或自定义端口的人用的。换电脑或更新软件后，插件会自动把自带服务程序路径迁到当前机器；普通用户保持默认即可。
                    </p>
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
                      <span>服务程序路径（默认不用改）</span>
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
                      <span>启动参数（默认不用改）</span>
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
                  ? '外接 VLM API 保存后可直接检测连接；如果 API 需要密钥，请填写 API Key。'
                  : '本地 VLM 会自动使用插件自带的 llama.cpp 服务程序。换电脑后如果旧路径失效，保存或启动时会自动迁到当前安装位置。'}
                {vlmMessage ? ` ${vlmMessage}` : ''}
              </p>
            </div>
          </div>
          <div className="analysis-settings-group">
            <div className="analysis-settings-group-header">
              <strong>分析参数</strong>
              <span>摘要、命名和标签会用到文本模型</span>
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
                ? '文本理解会调用下方外部 OpenAI 兼容 API。视觉模型仍需要在上方单独配置；不知道怎么选时，外接 API 通常更省心。'
                : '本地文本模型需要你先启动 Ollama、LM Studio 或其他 OpenAI 兼容服务。没有本地服务时，请切换到“外接大模型 API”。'}
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
