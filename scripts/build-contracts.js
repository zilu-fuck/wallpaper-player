const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const check = process.argv.includes('--check')
for (const name of ['contracts', 'domain']) {
const root = path.resolve(__dirname, '../packages', name)
const configPath = path.join(root, 'tsconfig.json')
const read = ts.readConfigFile(configPath, ts.sys.readFile)
const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
const program = ts.createProgram(config.fileNames, config.options)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n'
  }))
  process.exitCode = 1
} else {
  const result = program.emit(undefined, (file, content) => {
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) {
        console.error('Generated contract needs rebuild: ' + path.relative(root, file))
        process.exitCode = 1
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
  })
  if (result.emitSkipped) process.exitCode = 1
  if (!process.exitCode) console.log(check ? 'shared ' + name + ' and declarations are current' : 'shared ' + name + ' compiled')
}

}
