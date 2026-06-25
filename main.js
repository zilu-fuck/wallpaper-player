const path = require('path')
const { app } = require('electron')

if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Data'))
}

require('./main/index.js')
