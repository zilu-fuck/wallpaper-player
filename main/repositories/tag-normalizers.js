const MAX_TAG_RECEIPTS = 1024

function normalizeTagRevisions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key, revision]) =>
    /^[a-f0-9]{64}$/.test(key) && Number.isSafeInteger(revision) && revision >= 0))
}

function normalizeTagReceipts(value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => item && ['operationHash', 'targetHash', 'payloadHash'].every(key =>
    /^[a-f0-9]{64}$/.test(item[key])) && Number.isSafeInteger(item.revision) && item.revision >= 0)
    .slice(0, MAX_TAG_RECEIPTS).map(({ operationHash, targetHash, payloadHash, revision }) =>
      ({ operationHash, targetHash, payloadHash, revision }))
}

module.exports = { normalizeTagRevisions, normalizeTagReceipts }
