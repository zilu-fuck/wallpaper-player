const os = require('os')

function getAddressScore(entry, name) {
  const address = entry.address
  const interfaceName = String(name || '').toLowerCase()

  if (interfaceName.includes('vpn') || interfaceName.includes('radmin') || interfaceName.includes('tailscale')) {
    return 30
  }
  if (address.startsWith('192.168.') || address.startsWith('10.')) {
    return 10
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) {
    return 12
  }
  return 20
}

function getLanAddresses(port) {
  const addresses = []
  const interfaces = os.networkInterfaces()

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      addresses.push({
        url: `http://${entry.address}:${port}`,
        score: getAddressScore(entry, name)
      })
    }
  }

  return addresses
    .sort((a, b) => a.score - b.score || a.url.localeCompare(b.url))
    .map(item => item.url)
}

function getPrimaryEndpoint(port) {
  return getLanAddresses(port)[0] || `http://127.0.0.1:${port}`
}

module.exports = {
  getLanAddresses,
  getPrimaryEndpoint
}
