export class DownloadSubmission {
  constructor(api) { this.api = api; this.current = null; this.disposed = false }
  cancelPreparation(record) {
    if (record && !record.settled) { try { Promise.resolve(this.api?.cancelMediaWork?.(record.operationId)).catch(() => {}) } catch {} }
  }
  newIntent() { this.cancelPreparation(this.current); this.current = null }
  async submit(method, payload) {
    if (this.disposed) throw new Error('下载面板已关闭')
    const descriptor = JSON.stringify([method, payload.dir, payload.magnet || payload.url || null,
      payload.resource ? [payload.resource.id, payload.resource.url, payload.resource.kind] : null])
    let record = this.current
    if (!record || record.descriptor !== descriptor) {
      this.cancelPreparation(record)
      record = { descriptor, operationId: 'add-' + crypto.randomUUID(), pending: null, settled: false }
      this.current = record
    }
    if (record.pending) return record.pending
    record.pending = this.api[method]({ ...payload, operationId: record.operationId, requestId: record.operationId })
      .then(result => {
        record.settled = true
        if (this.disposed || this.current !== record) throw Object.assign(new Error('下载操作已替换'), { code: 'download_submission_retired' })
        if (result?.success === false) this.current = null
        return result
      })
      .catch(error => {
        if (this.disposed || this.current !== record) throw Object.assign(new Error('下载操作已替换'), { code: 'download_submission_retired' })
        throw new Error('接收结果未确认，请刷新状态；再次提交相同内容会核对原操作，避免重复下载')
      })
      .finally(() => { record.pending = null })
    return record.pending
  }
  dispose() {
    this.disposed = true
    this.cancelPreparation(this.current)
  }
}
