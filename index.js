const main = require('./lib/dockerManager.js')
let config = require('./jsreport.config.js')

module.exports = (options) => {
  config = Object.assign({}, config)
  config.options = Object.assign({}, options)
  config.main = main
  config.directory = __dirname
  return config
}
