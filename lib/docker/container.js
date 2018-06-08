const axios = require('axios')
const Promise = require('bluebird')
const execAsync = Promise.promisify(require('child_process').exec)

module.exports = class Container {
  constructor ({
    id,
    port,
    image,
    exposedPort,
    network,
    startTimeout,
    restartPolicy,
    restartTimeout,
    logger
  }) {
    const localIp = '127.0.0.1'
    this.port = port
    this.image = image
    this.exposedPort = exposedPort
    this.network = network
    this.startTimeout = startTimeout
    this.restartPolicy = restartPolicy
    this.id = id
    this.logger = logger

    this.url = `http://${localIp}:${port}`
  }

  async start () {
    try {
      // if container exists we remove it first before try to start it
      await execAsync(`docker container inspect ${this.id}`)

      this.logger.debug(`docker container with name ${this.id} already exists, removing it`)

      await execAsync(`docker rm -f ${this.id}`)
    } catch (e) {}

    try {
      const runCMD = `docker run -d -p ${this.port}:${this.exposedPort} --network=${this.network} -v /tmp/jsreport-worker-temp:/tmp --name ${this.id} --read-only ${this.image}`

      this.logger.debug(`docker run cmd: ${runCMD}`)

      await execAsync(runCMD)

      await this.waitForPing()
    } catch (e) {
      throw e
    }
  }

  async waitForPing () {
    let finished = false
    let start = new Date().getTime()

    while (!finished) {
      try {
        await axios.get(this.url)
        finished = true
      } catch (e) {
        await Promise.delay(50)
      }

      if (start + this.startTimeout < new Date().getTime()) {
        throw new Error(`Unable to ping docker container ${this.id} (${this.url}) after ${this.startTimeout}ms`)
      }
    }
  }

  async restart () {
    if (this.restartPolicy === false) {
      return Promise.resolve(this)
    }

    this.logger.debug(`Restarting docker container ${this.id} (${this.url}) (in progress)`)

    try {
      await execAsync(`docker restart -t 0 ${this.id}`, {
        timeout: this.restartTimeout
      })

      await this.waitForPing()
    } catch (e) {
      e.message = `Error while re-starting docker container ${this.id} (${this.url}). ${e.message}`
      throw e
    }
  }

  async remove () {
    try {
      await execAsync(`docker rm -f ${this.id}`)
    } catch (e) {
      this.logger.warn(`Remove docker container ${this.id} (${this.url}) failed.`, e)
    }
  }
}
