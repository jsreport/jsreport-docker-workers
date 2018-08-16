const axios = require('axios')
const Promise = require('bluebird')
const execAsync = Promise.promisify(require('child_process').exec)

module.exports = class Container {
  constructor ({
    debuggingSession,
    hostIp,
    id,
    idx,
    port,
    image,
    exposedPort,
    network,
    customEnv,
    startTimeout,
    restartPolicy,
    restartTimeout,
    logger,
    memorySwap = '512m',
    memory = '420m',
    cpuQuota = 50000
  }) {
    this.debuggingSession = debuggingSession
    this.port = port
    this.image = image
    this.exposedPort = exposedPort
    this.customEnv = customEnv
    this.network = network
    this.startTimeout = startTimeout
    this.restartPolicy = restartPolicy
    this.id = id
    this.idx = idx
    this.logger = logger
    this.memory = memory
    this.memorySwap = memorySwap
    this.cpuQuota = cpuQuota

    this.url = `http://${hostIp}:${port}`
  }

  async start () {
    try {
      // if container exists we remove it first before try to start it
      await execAsync(`docker container inspect ${this.id}`)

      this.logger.debug(`docker container with name ${this.id} already exists, removing it`)

      await execAsync(`docker rm -f ${this.id}`)
    } catch (e) {}

    try {
      let runCMD = `docker run -d -p ${this.port}:${this.exposedPort}`
      const debugPort = 9229 + (this.idx + 1)

      if (this.debuggingSession) {
        runCMD += ` --expose 9229 -p ${debugPort}:9229`
      }

      runCMD += ` --network=${this.network} -v /tmp/${this.id}:/tmp --name ${this.id} --read-only`

      runCMD += ` --memory="${this.memory}" --memory-swap="${this.memorySwap}" --cpu-quota=${this.cpuQuota}`

      if (this.debuggingSession) {
        runCMD += ` --env workerDebuggingSession=true`
      }

      if (Array.isArray(this.customEnv) && this.customEnv.length > 0) {
        this.customEnv.forEach((envDef) => {
          runCMD += ` --env ${envDef}`
        })
      }

      runCMD += ` ${this.image}`

      if (this.debuggingSession) {
        this.logger.debug(`docker run cmd: ${runCMD} debug port: ${debugPort}`)
      } else {
        this.logger.debug(`docker run cmd: ${runCMD}`)
      }

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
      this.logger.debug(`Restarting docker container was skipped because container restart policy is set to false`)
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
