const util = require('util')
const fs = require('fs')
const readFileAsync = util.promisify(fs.readFile)

module.exports = (reporter) => (req, res, next) => {
  (async () => {
    const file = req.query.file
    const type = req.query.type

    if (!file) {
      throw new Error('file was not specified')
    }

    if (!type) {
      throw new Error('type was not specified')
    }

    const fileInContainersTemp = reporter.dockerManager.containersManager.containers.some((c) => {
      return file.startsWith(c.tempVolumeHostPathOriginal) || file.startsWith(c.tempAutoCleanupDirectoryPathInHost)
    })

    if (
      !file.startsWith(reporter.options.tempDirectory) &&
      !file.startsWith(reporter.options.tempAutoCleanupDirectory) &&
      !fileInContainersTemp
    ) {
      throw new Error('Invalid temp file')
    }

    let content = await readFileAsync(file)
    let resType

    if (type === 'string') {
      content = content.toString()
      resType = 'text/plain'
    } else {
      resType = 'application/buffer'
    }

    res.set('Content-Type', resType)

    res.end(content)
  })().catch((e) => {
    const status = e.code === 'ENOENT' ? 404 : 400

    res.status(status).json({
      message: e.message,
      stack: e.stack
    })
  })
}
