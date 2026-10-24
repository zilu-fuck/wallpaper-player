const { updateSettingsAndFlush, loadSettingsFields, loadSettingsMapKeys } = require('../settings')

const fields = Object.freeze(Object.fromEntries(Object.entries({
  favorite: ['favorites'],
  readTags: ['customTags', 'customTagRevisions'],
  writeTags: ['customTags', 'customTagRevisions', 'tagMutationReceipts'],
  appendTags: ['customTags', 'customTagRevisions'],
  playback: ['playbackStates']
}).map(([operation, keys]) => [operation, Object.freeze(keys)])))

// This logical repository shares the existing JSON transaction and durable boundary.
// Preparation gets only detached key names/favorite values; updates get only their fields.
function updateUserMedia(operation, update, { prepare, ...options } = {}) {
  const selection = fields[operation]
  if (!Object.hasOwn(fields, operation)) throw new TypeError('Unknown user-media operation')
  return updateSettingsAndFlush((current, prepared) => {
    const mutation = update(current, prepared)
    if (Object.keys(mutation?.patch || {}).some(key => !selection.includes(key))) {
      throw new TypeError('User-media transaction cannot change unrelated settings')
    }
    return mutation
  }, { ...options, fields: selection, prepareFields: [],
    prepare: prepare && (() => prepare({
      ...(selection.includes('customTags') ? { customTagKeys: loadSettingsMapKeys('customTags') } : {}),
      ...(selection.includes('favorites') ? loadSettingsFields(['favorites']) : {})
    })) })
}

module.exports = { updateUserMedia }
