const assert = require('assert')

const browser = require('../main/plugins/ai-search/browser')
const {
  buildBaseTitle,
  generateSearchQueries,
  getNextTargets
} = require('../main/plugins/ai-search/title-cleaner')
const {
  computeConfidenceResult,
  buildPlayableSearchQueries,
  scoreCandidatesForTest
} = require('../main/plugins/ai-search/search-engine')

function videoEvidence(title, url, bodyText = '') {
  return {
    title,
    url,
    snippet: title,
    bodyText,
    siteName: new URL(url).hostname,
    sourceLevel: 'video',
    sourceScore: 1
  }
}

function databaseEvidence(title, url, bodyText = '') {
  return {
    title,
    url,
    snippet: title,
    bodyText,
    siteName: new URL(url).hostname,
    sourceLevel: 'database',
    sourceScore: 0.9
  }
}

function sequelCandidate(sourceUrls) {
  return {
    candidateTitle: '黑袍纠察队 第二季 / 第2集',
    relationship: 'sequel',
    evidence: ['找到第2集和第二季播放页'],
    conflicts: [],
    reason: '有后续剧集播放页',
    sourceUrls
  }
}

function confidence(candidate, evidence) {
  return computeConfidenceResult(candidate, evidence, '黑袍纠察队 第一季 第一集', 'sequel', {
    targetRequirements: getNextTargets('黑袍纠察队 第一季 第一集')
  })
}

const targets = getNextTargets('黑袍纠察队 第一季 第一集')
assert.deepStrictEqual(targets, [
  { type: 'season', number: 2 },
  { type: 'episode', number: 2 }
])
assert.strictEqual(buildBaseTitle('黑袍纠察队 第一季 第一集'), '黑袍纠察队')

const queries = generateSearchQueries('黑袍纠察队 第一季 第一集', 'sequel', [], {})
assert.ok(queries.some(query => query.includes('第二集') && query.includes('在线观看')))
assert.ok(queries.some(query => query.includes('第二季') && query.includes('在线观看')))

const secondSeasonQueries = generateSearchQueries('黑袍纠察队 第二季 第一集', 'sequel', [], {})
assert.ok(secondSeasonQueries.some(query => /第(?:2|二)集/.test(query) && query.includes('在线观看')))
assert.ok(secondSeasonQueries.some(query => /第(?:3|三)季/.test(query) && query.includes('在线观看')))
assert.ok(!secondSeasonQueries.some(query => query === '黑袍纠察队 第二季 在线观看'))

const playableQueries = buildPlayableSearchQueries(
  [{ candidateTitle: '黑袍纠察队 第二季' }, { candidateTitle: '黑袍纠察队 第2集' }],
  '黑袍纠察队 第一季 第一集',
  targets
)
assert.ok(playableQueries[0].includes('第2季') || playableQueries[0].includes('第二季'))
assert.ok(playableQueries.some(query => query.includes('第2集') && query.includes('在线观看')))
assert.ok(playableQueries.some(query => query.includes('第2季') && query.includes('在线观看')))

assert.strictEqual(browser.isVideoPageUrl('https://movie.douban.com/subject/123456/'), false)
assert.strictEqual(browser.isVideoPageUrl('https://example.com/vodplay/123-1-1.html'), true)
assert.strictEqual(browser.isVideoPageUrl('https://example.com/play/the-boys-s01e02.html'), true)
assert.strictEqual(browser.isVideoPageUrl('https://example.com/detail/the-boys-season-2.html'), true)
assert.strictEqual(browser.isVideoPageUrl('https://example.com/the-boys-season-2-guide'), false)
assert.strictEqual(browser.isVideoPageUrl('https://example.com/search/the-boys-season-2.html'), false)

const infoOnlyEvidence = [
  databaseEvidence(
    '黑袍纠察队 第二季 豆瓣',
    'https://movie.douban.com/subject/34900000/',
    '黑袍纠察队 第二季 已播出'
  )
]
const infoOnly = confidence(sequelCandidate(['https://movie.douban.com/subject/34900000/']), infoOnlyEvidence)
assert.ok(infoOnly.score <= 0.64, `info-only sequel should be capped, got ${infoOnly.score}`)
assert.strictEqual(infoOnly.details.videoEvidenceCount, 0)

const seasonOnlyEvidence = [
  videoEvidence(
    '黑袍纠察队 第二季 在线观看',
    'https://example.com/vodplay/the-boys-season-2-1.html',
    '黑袍纠察队 第二季 在线观看'
  )
]
const seasonOnly = confidence(sequelCandidate(seasonOnlyEvidence.map(item => item.url)), seasonOnlyEvidence)
assert.ok(seasonOnly.score <= 0.78, `missing episode target should be capped, got ${seasonOnly.score}`)
assert.deepStrictEqual(seasonOnly.details.missingTargets, ['第2集'])

const episodeOnlyEvidence = [
  videoEvidence(
    'The Boys S01E02 Watch Online',
    'https://example.com/play/the-boys-s01e02.html',
    'The Boys S01E02 Watch Online'
  )
]
const episodeOnly = confidence(sequelCandidate(episodeOnlyEvidence.map(item => item.url)), episodeOnlyEvidence)
assert.deepStrictEqual(episodeOnly.details.matchedTargets, ['第2集'])
assert.ok(episodeOnly.score <= 0.78, `missing season target should be capped, got ${episodeOnly.score}`)
assert.ok(episodeOnly.score > infoOnly.score, `target video page should score above info-only evidence: ${episodeOnly.score} <= ${infoOnly.score}`)

const bothTargetEvidence = [
  videoEvidence(
    '黑袍纠察队 第2集 在线观看',
    'https://example.com/vodplay/the-boys-s01e02.html',
    '黑袍纠察队 第2集 在线观看'
  ),
  videoEvidence(
    '黑袍纠察队 第二季 在线观看',
    'https://example.com/vodplay/the-boys-season-2-1.html',
    '黑袍纠察队 第二季 在线观看'
  ),
  databaseEvidence(
    '黑袍纠察队 分集列表',
    'https://www.imdb.com/title/tt1190634/episodes/',
    'Season 1 Episode 2 and Season 2 episode list'
  )
]
const bothTarget = confidence(sequelCandidate(bothTargetEvidence.map(item => item.url)), bothTargetEvidence)
assert.deepStrictEqual(bothTarget.details.missingTargets, [])
assert.ok(bothTarget.details.videoEvidenceCount >= 2)
assert.ok(bothTarget.score > seasonOnly.score, `full target coverage should score higher: ${bothTarget.score} <= ${seasonOnly.score}`)

const splitCandidates = scoreCandidatesForTest([
  {
    candidateTitle: '黑袍纠察队 第2集',
    relationship: 'sequel',
    evidence: ['黑袍纠察队 第2集 在线观看'],
    conflicts: [],
    sourceUrls: ['https://example.com/vodplay/the-boys-s01e02.html']
  },
  {
    candidateTitle: '黑袍纠察队 第二季',
    relationship: 'sequel',
    evidence: ['黑袍纠察队 第二季 在线观看'],
    conflicts: [],
    sourceUrls: ['https://example.com/vodplay/the-boys-season-2-1.html']
  }
], bothTargetEvidence, '黑袍纠察队 第一季 第一集', 'sequel', targets)
assert.deepStrictEqual(splitCandidates[0].confidenceDetails.resultMissingTargets, [])
assert.deepStrictEqual(splitCandidates[1].confidenceDetails.resultMissingTargets, [])

const youtubeEvidence = [
  videoEvidence('候选 A Episode 2', 'https://www.youtube.com/watch?v=aaa111', '候选 A Episode 2'),
  videoEvidence('候选 B Episode 2', 'https://www.youtube.com/watch?v=bbb222', '候选 B Episode 2')
]
const youtubeA = computeConfidenceResult({
  candidateTitle: '候选 A Episode 2',
  relationship: 'sequel',
  evidence: ['候选 A Episode 2'],
  sourceUrls: ['https://www.youtube.com/watch?v=aaa111']
}, youtubeEvidence, '候选 A Episode 1', 'sequel', {
  targetRequirements: [{ type: 'episode', number: 2 }]
})
assert.strictEqual(youtubeA.details.matchedEvidenceCount, 1)
assert.deepStrictEqual(youtubeA.details.supportingSources, ['youtube.com'])

const genericPlayEvidence = [
  videoEvidence(
    '黑袍纠察队 第2集 在线观看',
    'https://example.com/play/the-boys-s01e02.html',
    '黑袍纠察队 第2集 在线观看'
  ),
  videoEvidence(
    '黑袍纠察队 第二季 详情播放',
    'https://example.com/detail/the-boys-season-2.html',
    '黑袍纠察队 第二季 在线观看'
  )
]
const genericPlay = confidence(sequelCandidate(genericPlayEvidence.map(item => item.url)), genericPlayEvidence)
assert.deepStrictEqual(genericPlay.details.missingTargets, [])
assert.ok(genericPlay.score > seasonOnly.score, `generic playable pages should cover sequel targets: ${genericPlay.score} <= ${seasonOnly.score}`)

console.log('ai search verification passed')
