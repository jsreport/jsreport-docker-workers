const path = require('path')
const axios = require('axios')
const Promise = require('bluebird')
const execAsync = Promise.promisify(require('child_process').exec)
const FS = require('fs-extra')

async function cleanWorkerTemp (dir) {
  await FS.mkdirp(path.join(dir, 'autocleanup'))

  let items
  try {
    items = await FS.readdir(dir)
  } catch (e) {
    return
  }

  await Promise.all(items.map((i) => {
    if (i === 'autocleanup') {
      // we can't delete autocleanup directory itself, because it would crash reaper interval in reporter
      return FS.emptyDir(path.join(dir, i))
    }

    return FS.remove(path.join(dir, i))
  }))
}

// change c:\\foo to /c/foo because docker run -v c:\temp fails
// the linux path wan't be affected
function normalizeWindowsPathForDocker (p) {
  p = p.replace(/\\/g, '/').replace(':', '')

  if (p[0] !== '/') {
    return '/' + p
  }

  return p
}

module.exports = class Container {
  constructor ({
    hostIp,
    id,
    idx,
    port,
    network,
    logger,
    container,
    tempDirectory
  }) {
    this.debuggingSession = container.debuggingSession
    this.port = port
    this.image = container.image
    this.exposedPort = container.exposedPort
    this.customEnv = container.customEnv
    this.network = network
    this.startTimeout = container.startTimeout
    this.restartPolicy = container.restartPolicy
    this.id = id
    this.idx = idx
    this.logger = logger
    this.memory = container.memory
    this.memorySwap = container.memorySwap
    this.cpus = container.cpus
    this.logDriver = container.logDriver
    this.logOpt = container.logOpt || { 'max-size': '1m', 'max-file': '10' }
    this.tempDirectory = tempDirectory

    this.url = `http://${hostIp}:${port}`

    this.tempVolumeTargetPath = container.tempVolumeTarget

    // when running docker host on windows the path.join produces windows looking path
    // we need to convert it to the linux one because the container runs linux
    this.tempAutoCleanupDirectoryPathInContainer = path.join(this.tempVolumeTargetPath, 'autocleanup').replace(/\\/g, '/')

    if (container.tempVolumeSourcePrefix) {
      this.tempVolumeHostPath = normalizeWindowsPathForDocker(path.join(container.tempVolumeSourcePrefix, 'jsreport', 'workers', this.id))
    } else {
      this.tempVolumeHostPath = path.join(this.tempDirectory, 'workers', this.id)
    }

    this.tempAutoCleanupDirectoryPathInHost = path.join(this.tempVolumeHostPath, 'autocleanup')
  }

  async start () {
    try {
      // the volume mount needs to run on already existing path
      await cleanWorkerTemp(this.tempVolumeHostPath)

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

      runCMD += ` --network=${this.network} -v ${this.tempVolumeHostPath}:${this.tempVolumeTargetPath} --name ${this.id} --read-only`

      runCMD += ` --memory="${this.memory}" --memory-swap="${this.memorySwap}" --cpus="${this.cpus}"`

      runCMD += ` --log-driver=${this.logDriver} `
      runCMD += Object.entries(this.logOpt).map(e => `--log-opt ${e[0]}=${e[1]}`).join(' ')

      if (Array.isArray(this.customEnv) && this.customEnv.length > 0) {
        this.customEnv.forEach((envDef) => {
          runCMD += ` --env ${envDef}`
        })
      }

      runCMD += ` --env workerTempDirectory="${this.tempVolumeTargetPath}"`
      runCMD += ` --env workerTempAutoCleanupDirectory="${this.tempAutoCleanupDirectoryPathInContainer}"`

      if (this.debuggingSession) {
        runCMD += ` --env workerDebuggingSession=true`
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
      try {
        await cleanWorkerTemp(this.tempVolumeHostPath)
      } catch (e) {
        this.logger.warn('Failed to clean worker autcleanup folder during restart ' + e.stack)
      }
    } catch (e) {
      e.message = `Error while re-starting docker container ${this.id} (${this.url}). ${e.message}`
      throw e
    }
  }

  async remove () {
    try {
      await execAsync(`docker rm -f ${this.id}`)
      await cleanWorkerTemp(this.tempVolumeHostPath)
    } catch (e) {
      this.logger.warn(`Remove docker container ${this.id} (${this.url}) failed.`, e)
    }
  }
}
