const Promise = require('bluebird')
const execAsync = Promise.promisify(require('child_process').exec)
const axios = require('axios')

async function waitForPing (url) {
  let finished = false
  let start = new Date().getTime()
  while (!finished) {
    try {
      await axios.get(url)
      finished = true
    } catch (e) {
      await Promise.delay(100)
    }

    if (start + 10000 < new Date().getTime()) {
      throw new Error(`Unable to ping ${url}`)
    }
  }
}

module.exports = (reporter, definition) => {
  reporter.beforeRenderListeners.add('docker-workers', async (req, res) => {
    reporter.logger.debug('Docker restart')
    try {
      await execAsync('docker restart -t 0 worker1')
    } catch (e) {

    }
    try {
      await execAsync('docker run -d -p 2000:2000 --name worker1 --read-only worker')
    } catch (e) {

    }

    req.context.workerUrl = 'http://localhost:2000'
    reporter.logger.debug('Wait for container healthy')
    await waitForPing('http://localhost:2000')
    reporter.logger.debug('Container ready')
  })
}
