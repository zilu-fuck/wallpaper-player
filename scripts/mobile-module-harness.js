const fs = require('fs')
const path = require('path')
const vm = require('vm')
const ts = require('typescript')
const projectRoot = path.resolve(__dirname, '..')
const sharedAliases = require('./shared-aliases.cjs')
const nativeFetch = global.fetch

function createStorage() {
  const values = new Map()
  let failWrite = null
  const api = {
    async getItem(key) { await Promise.resolve(); return values.get(key) ?? null },
    async setItem(key, value) {
      await Promise.resolve()
      if (failWrite && failWrite(key)) { failWrite = null; throw new Error('injected storage failure') }
      values.set(key, value)
    },
    async removeItem(key) { values.delete(key) },
    async getAllKeys() { return [...values.keys()] },
    async multiRemove(keys) { keys.forEach(key => values.delete(key)) }
  }
  return { api, values, failNextWrite: predicate => { failWrite = predicate } }
}
function phone() {
  const async = createStorage()
  const secure = createStorage()
  const modules = new Map()
  const control = { online: true, loseNextPut: false, hold: null }
  const stubs = {
    '@react-native-async-storage/async-storage': { __esModule: true, default: async.api },
    'expo-secure-store': { getItemAsync: secure.api.getItem, setItemAsync: secure.api.setItem, deleteItemAsync: secure.api.removeItem },
    'react-native': { Platform: { OS: 'android' } }
  }
  async function fetch(url, options) {
    if (!control.online) throw new Error('network unavailable')
    if (control.hold) await control.hold(url, options)
    const response = await nativeFetch(url, options)
    if (control.loseNextPut && options?.method === 'PUT' && String(url).includes('/v1/playback/')) {
      control.loseNextPut = false
      throw new Error('network response lost')
    }
    return response
  }
  function load(relative) {
    const file = path.resolve(projectRoot, relative)
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX
    }, fileName: file }).outputText
    function requireProduction(name) {
      if (Object.hasOwn(stubs, name)) return stubs[name]
      if (Object.hasOwn(sharedAliases, name)) return require(sharedAliases[name])
      if (name.startsWith('.')) {
        const absolute = path.resolve(path.dirname(file), name)
        if (fs.existsSync(path.join(absolute, 'package.json'))) return require(absolute)
        const resolved = (path.extname(absolute) ? [absolute] : ['.ts', '.tsx', '.js', '.jsx', '.json'].map(extension => absolute + extension)).find(fs.existsSync)
        if (!resolved) throw new Error('unresolved production import ' + name)
        if (resolved.endsWith('.json')) return JSON.parse(fs.readFileSync(resolved, 'utf8'))
        return load(path.relative(projectRoot, resolved))
      }
      throw new Error('unmocked native import ' + name)
    }
    vm.runInNewContext(source, { exports: module.exports, module, require: requireProduction,
      setTimeout, clearTimeout, AbortController, fetch, Date, Math, Map, Set, Promise, URL, console,
      Error, TypeError, RangeError, SyntaxError,
      ...(control.globals || {}) }, { filename: file })
    return module.exports
  }
  return { async, secure, control, load, stubs,
    override(relative, exports) { modules.set(path.resolve(projectRoot, relative), { exports }) },
    rebootPlayback() { modules.delete(path.resolve(projectRoot, 'mobile/src/persistence/playback.ts')) } }
}

module.exports = { phone, createStorage }
