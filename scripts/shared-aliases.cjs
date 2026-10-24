const path = require('node:path')
const { compilerOptions } = require('../tsconfig.shared-aliases.json')
module.exports = Object.fromEntries(Object.entries(compilerOptions.paths).map(([name, [target]]) =>
  [name, path.resolve(__dirname, '..', target).replaceAll('\\', '/')]))
