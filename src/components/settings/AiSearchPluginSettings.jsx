import { useCallback, useMemo, useState } from 'react'

const PROVIDER_OPTIONS = [
  { value: 'local', label: '本地 LLM', description: 'Ollama / LM Studio 等本地服务' },
  { value: 'cloud', label: '云端 API', description: 'OpenAI 兼容的云端服务' },
  { value: 'dify', label: 'Dify', description: 'Dify 应用端点' }
]

function Field({
  label,
  description,
  error,
  children,
  required
}) {
  return (
    <label className="ai-search-setting-field">
      <span className="ai-search-setting-label">
        {label}
        {required ? <span className="ai-search-setting-required">*</span> : null}
      </span>
      {children}
      {error ? <small className="ai-search-setting-error">{error}</small> : null}
      {description && !error ? <small className="ai-search-setting-desc">{description}</small> : null}
    </label>
  )
}

function normalizeTrustedSite(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const withProtocol = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`
    const url = new URL(withProtocol)
    return url.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return text
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .trim()
      .toLowerCase()
  }
}

function splitSiteInput(value) {
  return String(value || '')
    .split(/[\s,，;；\n\r]+/)
    .map(normalizeTrustedSite)
    .filter(Boolean)
}

function splitTagInput(value) {
  return String(value || '')
    .split(/[,，;；\n\r]+/)
    .map(tag => tag.trim())
    .filter(Boolean)
}

function normalizeTrustedRules(value) {
  if (typeof value === 'string') {
    try {
      return normalizeTrustedRules(JSON.parse(value || '{}'))
    } catch {
      return { sites: [], tagBindings: [] }
    }
  }
  const rules = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  const sites = Array.isArray(rules.sites)
    ? [...new Set(rules.sites.map(normalizeTrustedSite).filter(Boolean))]
    : []
  const bindingMap = new Map()
  if (Array.isArray(rules.tagBindings)) {
    for (const binding of rules.tagBindings) {
      const tags = splitTagInput(binding?.tag)
      const bindingSites = Array.isArray(binding?.sites)
        ? [...new Set(binding.sites.map(normalizeTrustedSite).filter(Boolean))]
        : []
      for (const tag of tags) {
        if (!bindingSites.length) continue
        const existingSites = bindingMap.get(tag) || []
        bindingMap.set(tag, [...new Set([...existingSites, ...bindingSites])])
      }
    }
  }
  const tagBindings = [...bindingMap.entries()]
    .map(([tag, bindingSites]) => ({ tag, sites: bindingSites }))
    .filter(binding => binding.tag && binding.sites.length)
  return { sites, tagBindings }
}

function uniqueTags(tags) {
  const seen = new Set()
  const result = []
  for (const value of tags) {
    const tag = String(value || '').trim()
    const key = tag.toLocaleLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

export default function AiSearchPluginSettings({
  plugin,
  configDrafts,
  configErrors,
  busy,
  onDraftChange,
  onSaveDraftConfig,
  onCommitConfig,
  draftChanged,
  availableTags = []
}) {
  const provider = configDrafts.llmProvider || plugin?.config?.llmProvider || 'local'
  const trustedRuleDraft = Object.prototype.hasOwnProperty.call(configDrafts, 'trustedSiteRules')
    ? configDrafts.trustedSiteRules
    : plugin?.config?.trustedSiteRules
  const trustedRules = useMemo(() => (
    normalizeTrustedRules(trustedRuleDraft)
  ), [trustedRuleDraft])
  const [trustedSiteInput, setTrustedSiteInput] = useState('')
  const [bindingTagInput, setBindingTagInput] = useState('')
  const [bindingSiteInput, setBindingSiteInput] = useState('')
  const [selectedBindingTags, setSelectedBindingTags] = useState([])
  const [tagSearch, setTagSearch] = useState('')
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const normalizedAvailableTags = useMemo(() => uniqueTags(availableTags), [availableTags])
  const selectedTagKeys = useMemo(() => (
    new Set(selectedBindingTags.map(tag => tag.toLocaleLowerCase()))
  ), [selectedBindingTags])
  const filteredAvailableTags = useMemo(() => {
    const keyword = tagSearch.trim().toLocaleLowerCase()
    return normalizedAvailableTags
      .filter(tag => !selectedTagKeys.has(tag.toLocaleLowerCase()))
      .filter(tag => !keyword || tag.toLocaleLowerCase().includes(keyword))
      .slice(0, 80)
  }, [normalizedAvailableTags, selectedTagKeys, tagSearch])

  const handleProviderChange = useCallback((value) => {
    onCommitConfig('llmProvider', value, true)
  }, [onCommitConfig])

  const handleDraft = useCallback((key, value) => {
    onDraftChange(key, value)
  }, [onDraftChange])

  const updateTrustedRules = useCallback((nextRules) => {
    onDraftChange('trustedSiteRules', normalizeTrustedRules(nextRules))
  }, [onDraftChange])

  const handleAddTrustedSites = useCallback(() => {
    const nextSites = splitSiteInput(trustedSiteInput)
    if (!nextSites.length) return
    updateTrustedRules({
      ...trustedRules,
      sites: [...new Set([...trustedRules.sites, ...nextSites])]
    })
    setTrustedSiteInput('')
  }, [trustedRules, trustedSiteInput, updateTrustedRules])

  const handleRemoveTrustedSite = useCallback((site) => {
    updateTrustedRules({
      ...trustedRules,
      sites: trustedRules.sites.filter(item => item !== site)
    })
  }, [trustedRules, updateTrustedRules])

  const handleAddTagBinding = useCallback(() => {
    const tags = uniqueTags([...selectedBindingTags, ...splitTagInput(bindingTagInput)])
    const sites = splitSiteInput(bindingSiteInput)
    if (!tags.length || !sites.length) return
    const bindingMap = new Map(trustedRules.tagBindings.map(binding => [binding.tag, binding.sites]))
    for (const tag of tags) {
      bindingMap.set(tag, [...new Set([...(bindingMap.get(tag) || []), ...sites])])
    }
    const tagBindings = [...bindingMap.entries()]
      .map(([tag, bindingSites]) => ({ tag, sites: bindingSites }))
      .filter(binding => binding.sites.length)
    updateTrustedRules({ ...trustedRules, tagBindings })
    setSelectedBindingTags([])
    setBindingTagInput('')
    setBindingSiteInput('')
    setTagSearch('')
    setTagPickerOpen(false)
  }, [bindingSiteInput, bindingTagInput, selectedBindingTags, trustedRules, updateTrustedRules])

  const handleToggleBindingTag = useCallback((tag) => {
    const normalized = String(tag || '').trim()
    if (!normalized) return
    const key = normalized.toLocaleLowerCase()
    setSelectedBindingTags(prev => (
      prev.some(item => item.toLocaleLowerCase() === key)
        ? prev.filter(item => item.toLocaleLowerCase() !== key)
        : [...prev, normalized]
    ))
    setTagSearch('')
    setTagPickerOpen(false)
  }, [])

  const handleRemoveSelectedBindingTag = useCallback((tag) => {
    const key = String(tag || '').toLocaleLowerCase()
    setSelectedBindingTags(prev => prev.filter(item => item.toLocaleLowerCase() !== key))
  }, [])

  const handleRemoveTagBinding = useCallback((tag) => {
    updateTrustedRules({
      ...trustedRules,
      tagBindings: trustedRules.tagBindings.filter(binding => binding.tag !== tag)
    })
  }, [trustedRules, updateTrustedRules])

  const handleRemoveBoundSite = useCallback((tag, site) => {
    updateTrustedRules({
      ...trustedRules,
      tagBindings: trustedRules.tagBindings
        .map(binding => (
          binding.tag === tag
            ? { ...binding, sites: binding.sites.filter(item => item !== site) }
            : binding
        ))
        .filter(binding => binding.sites.length)
    })
  }, [trustedRules, updateTrustedRules])

  const isDify = provider === 'dify'
  const isCloud = provider === 'cloud'
  const isLocal = provider === 'local'

  return (
    <div className="ai-search-settings">
      <div className="ai-search-settings-header">
        <div>
          <h3>AI 搜索配置</h3>
          <p>配置大语言模型与搜索行为参数，搜索结果将用于在右侧面板中查找相关视频。</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSaveDraftConfig}
          disabled={busy || !draftChanged}
        >
          {busy ? '保存中...' : '保存配置'}
        </button>
      </div>

      {/* 提供商选择 */}
      <section className="ai-search-settings-section">
        <h4>LLM 提供商</h4>
        <div className="ai-search-provider-grid">
          {PROVIDER_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              className={`ai-search-provider-card${provider === option.value ? ' active' : ''}`}
              onClick={() => handleProviderChange(option.value)}
              disabled={busy}
            >
              <span className="ai-search-provider-radio" />
              <span className="ai-search-provider-title">{option.label}</span>
              <span className="ai-search-provider-desc">{option.description}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Dify */}
      {isDify ? (
        <section className="ai-search-settings-section">
          <h4>Dify 配置</h4>
          <div className="ai-search-settings-grid two-col">
            <Field
              label="Dify 端点"
              description="Dify API 的 Base URL，例如 http://localhost/v1"
              error={configErrors.difyEndpoint}
              required
            >
              <input
                type="text"
                value={configDrafts.difyEndpoint ?? ''}
                onChange={e => handleDraft('difyEndpoint', e.target.value)}
                placeholder="https://api.dify.dev/v1"
                disabled={busy}
              />
            </Field>
            <Field
              label="Dify API 密钥"
              description="Dify 应用的 API Key"
              error={configErrors.difyApiKey}
              required
            >
              <input
                type="password"
                value={configDrafts.difyApiKey ?? ''}
                onChange={e => handleDraft('difyApiKey', e.target.value)}
                placeholder="app-xxxxxxxx"
                disabled={busy}
              />
            </Field>
          </div>
        </section>
      ) : null}

      {/* 云端 */}
      {isCloud ? (
        <section className="ai-search-settings-section">
          <h4>云端 API 配置</h4>
          <div className="ai-search-settings-grid two-col">
            <Field
              label="云端 API Base URL"
              description="OpenAI 兼容接口的 Base URL"
              error={configErrors.cloudBaseUrl}
              required
            >
              <input
                type="text"
                value={configDrafts.cloudBaseUrl ?? ''}
                onChange={e => handleDraft('cloudBaseUrl', e.target.value)}
                placeholder="https://api.openai.com/v1"
                disabled={busy}
              />
            </Field>
            <Field
              label="云端模型名称"
              description="例如 gpt-4o、deepseek-chat"
              error={configErrors.cloudModelName}
              required
            >
              <input
                type="text"
                value={configDrafts.cloudModelName ?? ''}
                onChange={e => handleDraft('cloudModelName', e.target.value)}
                placeholder="gpt-4o"
                disabled={busy}
              />
            </Field>
            <Field
              label="云端 API 密钥"
              description="OpenAI 兼容接口的 API Key"
              error={configErrors.cloudApiKey}
              required
            >
              <input
                type="password"
                value={configDrafts.cloudApiKey ?? ''}
                onChange={e => handleDraft('cloudApiKey', e.target.value)}
                placeholder="sk-xxxxxxxx"
                disabled={busy}
              />
            </Field>
          </div>
        </section>
      ) : null}

      {/* 本地 */}
      {isLocal ? (
        <section className="ai-search-settings-section">
          <h4>本地 LLM 配置</h4>
          <div className="ai-search-settings-grid two-col">
            <Field
              label="本地 Base URL"
              description="Ollama / LM Studio 等本地服务地址"
              error={configErrors.localBaseUrl}
              required
            >
              <input
                type="text"
                value={configDrafts.localBaseUrl ?? ''}
                onChange={e => handleDraft('localBaseUrl', e.target.value)}
                placeholder="http://localhost:11434"
                disabled={busy}
              />
            </Field>
            <Field
              label="本地模型名称"
              description="例如 qwen2.5、llama3.1"
              error={configErrors.localModelName}
              required
            >
              <input
                type="text"
                value={configDrafts.localModelName ?? ''}
                onChange={e => handleDraft('localModelName', e.target.value)}
                placeholder="qwen2.5"
                disabled={busy}
              />
            </Field>
            <Field
              label="本地 API 密钥"
              description="本地服务如需鉴权可填写"
              error={configErrors.localApiKey}
            >
              <input
                type="password"
                value={configDrafts.localApiKey ?? ''}
                onChange={e => handleDraft('localApiKey', e.target.value)}
                placeholder="可选"
                disabled={busy}
              />
            </Field>
          </div>
        </section>
      ) : null}

      {/* 搜索行为 */}
      <section className="ai-search-settings-section">
        <h4>搜索行为</h4>
        <div className="ai-search-settings-grid two-col">
          <Field
            label="最大分页数"
            description="搜索返回的最大结果页数，范围 1-50"
            error={configErrors.maxPages}
          >
            <input
              type="number"
              min={1}
              max={50}
              value={configDrafts.maxPages ?? ''}
              onChange={e => handleDraft('maxPages', e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field
            label="超时时间（秒）"
            description="API 请求超时时间，范围 5-300"
            error={configErrors.timeout}
          >
            <input
              type="number"
              min={5}
              max={300}
              value={configDrafts.timeout ?? ''}
              onChange={e => handleDraft('timeout', e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field
            label="信任来源最低线索数"
            description="信任网站线索达到该数量后，先只基于信任来源推理"
            error={configErrors.trustedMinEvidence}
          >
            <input
              type="number"
              min={1}
              max={20}
              value={configDrafts.trustedMinEvidence ?? ''}
              onChange={e => handleDraft('trustedMinEvidence', e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field
            label="信任来源置信阈值"
            description="低于该置信度时继续搜索外部资料，范围 0.1-1"
            error={configErrors.trustedConfidenceThreshold}
          >
            <input
              type="number"
              min={0.1}
              max={1}
              step={0.01}
              value={configDrafts.trustedConfidenceThreshold ?? ''}
              onChange={e => handleDraft('trustedConfidenceThreshold', e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>
      </section>

      <section className="ai-search-settings-section">
        <h4>信任来源网站</h4>
        <div className="ai-search-trusted-panel">
          <div className="ai-search-trusted-editor">
            <Field
              label="全局信任网站"
              description="多个网站可用空格、逗号或换行分隔，例如 bangumi.tv bilibili.com"
              error={configErrors.trustedSiteRules}
            >
              <textarea
                value={trustedSiteInput}
                onChange={e => setTrustedSiteInput(e.target.value)}
                placeholder={'bangumi.tv\nbilibili.com'}
                disabled={busy}
              />
            </Field>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={handleAddTrustedSites}
              disabled={busy || !trustedSiteInput.trim()}
            >
              添加网站
            </button>
          </div>
          {trustedRules.sites.length ? (
            <div className="ai-search-trusted-chips">
              {trustedRules.sites.map(site => (
                <span key={site} className="ai-search-trusted-chip">
                  {site}
                  <button type="button" onClick={() => handleRemoveTrustedSite(site)} disabled={busy} aria-label={`移除 ${site}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="ai-search-trusted-empty">尚未添加全局信任网站。</p>
          )}
        </div>
      </section>

      <section className="ai-search-settings-section">
        <h4>标签绑定信任网站</h4>
        <div className="ai-search-tag-binding-editor">
          <Field label="绑定标签" description="从当前视频库已有标签中选择；与视频标签完全匹配时启用">
            <div className="ai-search-tag-picker">
              {selectedBindingTags.length ? (
                <div className="ai-search-tag-picker-selected">
                  {selectedBindingTags.map(tag => (
                    <span key={tag} className="ai-search-trusted-chip">
                      {tag}
                      <button type="button" onClick={() => handleRemoveSelectedBindingTag(tag)} disabled={busy} aria-label={`移除 ${tag}`}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <input
                type="search"
                value={tagSearch}
                onChange={e => setTagSearch(e.target.value)}
                onFocus={() => setTagPickerOpen(true)}
                onBlur={() => setTagPickerOpen(false)}
                placeholder="搜索已有标签"
                disabled={busy || normalizedAvailableTags.length === 0}
              />
              {tagPickerOpen ? (
                <div className="ai-search-tag-picker-menu" onMouseDown={e => e.preventDefault()}>
                  {filteredAvailableTags.length ? filteredAvailableTags.map(tag => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleToggleBindingTag(tag)}
                      disabled={busy}
                    >
                      {tag}
                    </button>
                  )) : (
                    <span>{normalizedAvailableTags.length ? '没有匹配的标签' : '当前视频库还没有可选标签'}</span>
                  )}
                </div>
              ) : null}
            </div>
            <textarea
              value={bindingTagInput}
              onChange={e => setBindingTagInput(e.target.value)}
              placeholder="手动补充标签"
              disabled={busy}
            />
          </Field>
          <Field label="绑定网站" description="多个网站可用空格、逗号或换行分隔">
            <textarea
              value={bindingSiteInput}
              onChange={e => setBindingSiteInput(e.target.value)}
              placeholder={'bangumi.tv\npixiv.net'}
              disabled={busy}
            />
          </Field>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleAddTagBinding}
            disabled={busy || (!selectedBindingTags.length && !bindingTagInput.trim()) || !bindingSiteInput.trim()}
          >
            添加绑定
          </button>
        </div>
        {trustedRules.tagBindings.length ? (
          <div className="ai-search-tag-binding-list">
            {trustedRules.tagBindings.map(binding => (
              <div key={binding.tag} className="ai-search-tag-binding-row">
                <div className="ai-search-tag-binding-head">
                  <strong>{binding.tag}</strong>
                  <button type="button" onClick={() => handleRemoveTagBinding(binding.tag)} disabled={busy}>
                    删除绑定
                  </button>
                </div>
                <div className="ai-search-trusted-chips">
                  {binding.sites.map(site => (
                    <span key={site} className="ai-search-trusted-chip">
                      {site}
                      <button type="button" onClick={() => handleRemoveBoundSite(binding.tag, site)} disabled={busy} aria-label={`移除 ${binding.tag} 的 ${site}`}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="ai-search-trusted-empty">尚未添加标签绑定。</p>
        )}
      </section>

      <div className="ai-search-settings-footer">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSaveDraftConfig}
          disabled={busy || !draftChanged}
        >
          {busy ? '保存中...' : '保存配置'}
        </button>
      </div>
    </div>
  )
}
