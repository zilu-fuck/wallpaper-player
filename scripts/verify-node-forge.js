const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const { createRequire } = require('node:module')

function verifyNodeForge({ load = createRequire(path.resolve(__dirname, '../mobile/package.json')), baseline = false, baselineValues = false } = {}) {
  const signing = load('@expo/code-signing-certificates')
  const consumer = createRequire(load.resolve('@expo/code-signing-certificates'))
  const forge = consumer('node-forge')
  assert.equal(forge, load('node-forge'), 'Expo must exercise the same Forge installation')
  const message = Buffer.from('Generated-key fixture for strict DigestInfo validation; no external keys or signatures')
  const result = { baseline, baselineValues, exponents: [], validPkcs1: 0, validOmittedParameters: 0, omittedParametersOpenSslAccepted: 0, malformedNested: 0, malformedValues: 0, existingMalformedOuter: 0, validPss: 0, expoSigning: 0, malformedExpoCertificates: 0, malformedExpoCsrs: 0 }
  const asn = forge.asn1, universal = asn.Class.UNIVERSAL
  const node = (type, constructed, value) => asn.create(universal, type, constructed, value)
  function digestInfo(algorithm, digest, form) {
    let identifier = asn.oidToDer(forge.oids[algorithm]).getBytes()
    if (form === 'noncanonical-oid') identifier = identifier.slice(0, -1) + '\x80'.repeat(16) + identifier.slice(-1)
    const oid = node(asn.Type.OID, false, identifier)
    const nil = () => node(asn.Type.NULL, false, form === 'null-value' ? 'fixture-extra-null-data' : '')
    const junk = () => node(asn.Type.OCTETSTRING, false, 'fixture-extra-element')
    const children = form === 'without-null' ? [oid] : form === 'no-null-extra' ? [oid, junk()] : [oid, nil()]
    if (form === 'extra-octet') children.push(junk())
    if (form === 'extra-null') children.push(nil())
    if (form === 'extra-sequence') children.push(node(asn.Type.SEQUENCE, true, [junk()]))
    const info = [node(asn.Type.SEQUENCE, true, children), node(asn.Type.OCTETSTRING, false, digest.toString('binary'))]
    if (form === 'outer-extra') info.push(junk())
    return Buffer.from(asn.toDer(node(asn.Type.SEQUENCE, true, info)).getBytes(), 'binary')
  }
  function signature(privateKey, algorithm, bytes, form) {
    const digest = crypto.createHash(algorithm).update(bytes).digest()
    const info = digestInfo(algorithm, digest, form), padding = 256 - info.length - 3
    assert.ok(padding >= 8, '2048-bit test key must fit canonical PKCS#1 padding')
    const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(padding, 0xff), Buffer.from([0]), info])
    return crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, encoded)
  }
  const accepts = action => { try { return action() === true } catch { return false } }
  for (const exponent of [3, 65537]) {
    // Keys live only in this process; never read or write user certificates/credentials.
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: exponent })
    const publicKey = forge.pki.publicKeyFromPem(keys.publicKey.export({ type: 'spki', format: 'pem' }))
    const keyPair = { publicKey, privateKey: forge.pki.privateKeyFromPem(keys.privateKey.export({ type: 'pkcs1', format: 'pem' })) }
    result.exponents.push(exponent)
    for (const algorithm of ['sha256', 'sha384', 'sha512']) {
      const digest = crypto.createHash(algorithm).update(message).digest().toString('binary')
      const normal = signature(keys.privateKey, algorithm, message, 'normal')
      assert.equal(crypto.verify(algorithm, message, keys.publicKey, normal), true)
      assert.equal(publicKey.verify(digest, normal.toString('binary')), true)
      result.validPkcs1++
      const omitted = signature(keys.privateKey, algorithm, message, 'without-null')
      assert.equal(publicKey.verify(digest, omitted.toString('binary')), true, 'absent optional NULL parameters remain valid')
      result.omittedParametersOpenSslAccepted += Number(crypto.verify(algorithm, message, keys.publicKey, omitted))
      result.validOmittedParameters++
      for (const form of ['extra-octet', 'extra-null', 'extra-sequence', 'no-null-extra']) {
        const malformed = signature(keys.privateKey, algorithm, message, form)
        assert.equal(crypto.verify(algorithm, message, keys.publicKey, malformed), false, 'OpenSSL rejects malformed nested DigestAlgorithm')
        assert.equal(accepts(() => publicKey.verify(digest, malformed.toString('binary'))), baseline,
          form + ': ' + (baseline ? 'baseline reproduces the parsing defect' : 'patched Forge must reject nested garbage'))
        result.malformedNested++
      }
      for (const form of ['null-value', 'noncanonical-oid']) {
        const malformed = signature(keys.privateKey, algorithm, message, form)
        assert.equal(crypto.verify(algorithm, message, keys.publicKey, malformed), false)
        assert.equal(accepts(() => publicKey.verify(digest, malformed.toString('binary'))), baseline || baselineValues, form + ' must be rejected')
        result.malformedValues++
      }
      const outer = signature(keys.privateKey, algorithm, message, 'outer-extra')
      assert.equal(accepts(() => publicKey.verify(digest, outer.toString('binary'))), false)
      result.existingMalformedOuter++
    }
    const pssSignature = crypto.sign('sha256', message, { key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
    assert.equal(publicKey.verify(crypto.createHash('sha256').update(message).digest().toString('binary'), pssSignature.toString('binary'),
      forge.pss.create({ md: forge.md.sha256.create(), mgf: forge.mgf.mgf1.create(forge.md.sha256.create()), saltLength: 32 })), true)
    result.validPss++
    const now = Date.now()
    const certificate = signing.generateSelfSignedCodeSigningCertificate({ keyPair, validityNotBefore: new Date(now - 60000),
      validityNotAfter: new Date(now + 86400000), commonName: 'Wallpaper isolated generated-key QA' })
    signing.validateSelfSignedCertificate(certificate, keyPair)
    const pem = signing.convertCertificateToCertificatePEM(certificate)
    assert.equal(new crypto.X509Certificate(pem).verify(keys.publicKey), true)
    const signed = signing.signBufferRSASHA256AndVerify(keyPair.privateKey, certificate, message)
    assert.equal(crypto.verify('sha256', message, keys.publicKey, Buffer.from(signed, 'base64')), true)
    const originalSignature = certificate.signature
    const tbs = Buffer.from(asn.toDer(forge.pki.certificateToAsn1(certificate).value[0]).getBytes(), 'binary')
    for (const form of ['extra-octet', 'null-value', 'noncanonical-oid']) {
      certificate.signature = signature(keys.privateKey, 'sha256', tbs, form).toString('binary')
      const certificateAccepted = accepts(() => { signing.validateSelfSignedCertificate(certificate, keyPair); return true })
      assert.equal(certificateAccepted, baseline || (form !== 'extra-octet' && baselineValues), 'actual Expo certificate validation rejects ' + form)
      result.malformedExpoCertificates++
    }
    certificate.signature = originalSignature
    const csr = signing.generateCSR(keyPair, 'Wallpaper isolated generated-key CSR')
    const info = Buffer.from(asn.toDer(forge.pki.certificationRequestToAsn1(csr).value[0]).getBytes(), 'binary')
    const csrSignature = csr.signature
    for (const form of ['extra-octet', 'null-value', 'noncanonical-oid']) {
      csr.signature = signature(keys.privateKey, 'sha256', info, form).toString('binary')
      const csrAccepted = accepts(() => { signing.generateDevelopmentCertificateFromCSR(keyPair.privateKey, certificate, csr, 'qa-application', 'qa-scope'); return true })
      assert.equal(csrAccepted, baseline || (form !== 'extra-octet' && baselineValues), 'actual Expo CSR validation rejects ' + form)
      result.malformedExpoCsrs++
    }
    csr.signature = csrSignature
    const development = signing.generateDevelopmentCertificateFromCSR(keyPair.privateKey, certificate, csr, 'qa-application', 'qa-scope')
    assert.equal(certificate.verify(development), true)
    result.expoSigning++
  }
  return result
}

if (require.main === module) {
  try { console.log(JSON.stringify(verifyNodeForge({ baseline: process.argv.includes('--baseline'), baselineValues: process.argv.includes('--baseline-values') }))) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
module.exports = { verifyNodeForge }
