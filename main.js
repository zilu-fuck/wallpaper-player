const { app } = require('electron')
const { configurePortableUserData } = require('./main/portable-user-data')

configurePortableUserData(app)

require('./main/index.js')
