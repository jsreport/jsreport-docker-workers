
const mkdirp = require('mkdirp')
const rimraf = require('rimraf')

function createDir (absoluteDir) {
  mkdirp.sync(absoluteDir)
}

function removeDir (absoluteDir) {
  rimraf.sync(absoluteDir)
}

exports.createDir = createDir
exports.removeDir = removeDir
