const crypto = require('crypto')
const { normalizedPathKey } = require('../paths')

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const { normalizeTagRevisions, normalizeTagReceipts } = require('./tag-normalizers')

function getTagRevisionKey(target, canonicalPathKey) {
  const key = target.favoriteKey || ''
  const location = target.path || target.fullPath || target.url || ''
  const scope = key.startsWith('workshop:') ? key
    : /^https?:\/\//i.test(location) ? `network:${key || location}`
      : `file:${canonicalPathKey || normalizedPathKey(location)}`
  return digest(scope)
}





function getTagsRevision(settings, target, canonicalPathKey) {
  return settings.customTagRevisions?.[getTagRevisionKey(target, canonicalPathKey)] || 0
}

function getTagOperation(actor, operationId, target, tags, canonicalPathKey) {
  return { operationHash: digest(`${actor}\0${operationId}`), targetHash: getTagRevisionKey(target, canonicalPathKey), payloadHash: digest(JSON.stringify(tags)) }
}

module.exports = { getTagOperation, getTagRevisionKey, getTagsRevision, normalizeTagReceipts, normalizeTagRevisions }
