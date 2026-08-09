const { execFile } = require('child_process')

// execFile 的 Promise 封装，统一超时/错误语义。
// 失败时 error 对象上附加 stdout/stderr，方便调用方做诊断。
function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

module.exports = { execFileAsync }
