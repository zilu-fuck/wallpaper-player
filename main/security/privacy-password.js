const crypto = require('crypto')
const busy = () => Object.assign(new Error('隐私密码操作过多，请稍后重试'), { code: 'privacy_busy', status: 429 })

function privacyPasswordText(password) {
  const text = typeof password === 'string' ? password : ''
  if (text.length > 65536 || Buffer.byteLength(text) > 65536) throw new Error('隐私密码不能超过 64 KiB')
  return text
}

function normalizePrivacy(privacy) {
  const value = privacy && typeof privacy === 'object' && !Array.isArray(privacy) ? privacy : {}
  const salt = typeof value.salt === 'string' && /^[0-9a-f]{32}$/i.test(value.salt) ? value.salt.toLowerCase() : ''
  const passwordHash = typeof value.passwordHash === 'string' && /^[0-9a-f]{64}$/i.test(value.passwordHash) ? value.passwordHash.toLowerCase() : ''
  return { salt, passwordHash, passwordSet: Boolean(salt && passwordHash) }
}

function createPrivacyPasswordService({ concurrent = 2, limit = 16, derive = (password, salt) => new Promise((resolve, reject) => {
  crypto.pbkdf2(password, salt, 120000, 32, 'sha256', (error, value) => error ? reject(error) : resolve(value))
}) } = {}) {
  const queue = []; let running = 0
  function pump() {
    while (queue.length && running < concurrent) {
      const item = queue.shift(); running++
      Promise.resolve().then(() => { item.check?.(); return derive(item.password, item.salt) })
        .then(value => { item.check?.(); item.resolve(value) }, item.reject).catch(item.reject)
        .finally(() => { running--; pump() })
    }
  }
  function hash(password, salt, check) {
    const text = privacyPasswordText(password)
    if (running + queue.length >= limit) return Promise.reject(busy())
    return new Promise((resolve, reject) => { queue.push({ password: text, salt, check, resolve, reject }); pump() })
  }
  return {
    async create(password, check) {
      if (typeof password !== 'string' || password.length < 4) throw new Error('隐私密码至少需要 4 位')
      const salt = crypto.randomBytes(16).toString('hex')
      return normalizePrivacy({ salt, passwordHash: (await hash(password, salt, check)).toString('hex') })
    },
    async verify(password, privacy, check) {
      const current = normalizePrivacy(privacy)
      if (!current.passwordSet) return false
      const actual = await hash(password, current.salt, check), expected = Buffer.from(current.passwordHash, 'hex')
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
    }
  }
}

// Serialize a principal's attempts so concurrent requests cannot all pass the same failure count.
function createPrivacyAttemptQueue(limit = 16) {
  const tails = new Map(); let pending = 0
  return (key, operation) => {
    if (pending >= limit) return Promise.reject(busy())
    pending++
    const work = (tails.get(key) || Promise.resolve()).then(operation).finally(() => pending--)
    const tail = work.catch(() => {}); tails.set(key, tail)
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
    return work
  }
}

const service = createPrivacyPasswordService()
module.exports = { normalizePrivacy, privacyPasswordText, createPrivacyPasswordService, createPrivacyAttemptQueue,
  createPrivacyPassword: (password, check) => service.create(password, check),
  verifyPrivacyPassword: (password, privacy, check) => service.verify(password, privacy, check) }
