
const Promise = require('bluebird')
const axios = require('axios')
const execAsync = Promise.promisify(require('child_process').exec)

class Container {
  constructor (reporter, registry, busyQueue, {
    id,
    port,
    image,
    exposedPort,
    network,
    startTimeout,
    restartPolicy,
    restartTimeout
  }) {
    const localIp = '127.0.0.1'

    this.reporter = reporter
    this.registry = registry
    this.busyQueue = busyQueue

    this.id = id
    this.port = port
    this.image = image
    this.exposedPort = exposedPort
    this.network = network
    this.url = `http://${localIp}:${port}`
    this.startTimeout = startTimeout
    this.restartPolicy = restartPolicy
    this.restartTimeout = restartTimeout
    this.numberOfRequests = 0
    this.lastUsed = new Date()
    this.tenant = null
  }

  async start () {
    try {
      // if container exists we remove it first before try to start it
      await execAsync(`docker container inspect ${this.id}`)

      this.reporter.logger.debug(`docker container with name ${this.id} already exists, removing it`)

      await execAsync(`docker rm -f ${this.id}`)
    } catch (e) {}

    try {
      const runCMD = `docker run -d -p ${this.port}:${this.exposedPort} --network=${this.network} -v /tmp/jsreport-worker-temp:/tmp --name ${this.id} --read-only ${this.image}`

      this.reporter.logger.debug(`docker run cmd: ${runCMD}`)

      await execAsync(runCMD)
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
        await Promise.delay(100)
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

    this.reporter.logger.debug(`Restarting docker container ${this.id} (${this.url}) (in progress)`)

    await execAsync(`docker restart -t 0 ${this.id}`, {
      timeout: this.restartTimeout
    })
  }

  async release (originalTenant, onBeforeRestart, shouldRestart) {
    if (shouldRestart === true) {
      this.reporter.logger.debug(`Releasing docker container (and restarting) ${this.id} (${this.url})`)

      await unregisterAndRestartContainer({
        reporter: this.reporter,
        container: this,
        originalTenant,
        onBeforeRestart,
        onRestart: () => {
          this.busyQueue.flush()
        }
      })

      this.busyQueue.flush()
    } else {
      this.reporter.logger.debug(`Releasing docker container ${this.id} (${this.url})`)

      this.numberOfRequests--
      this.busyQueue.flush()

      this.warmupNextOldContainer(onBeforeRestart)
    }
  }

  async warmupNextOldContainer (onBeforeRestart) {
    const container = this.registry.reduce((prev, current) => (prev.lastUsed < current.lastUsed) ? prev : current)

    if (!container) {
      return
    }

    if (container.numberOfRequests > 0) {
      return
    }

    if (!container.tenant) {
      return
    }

    this.reporter.logger.info(`Warming up docker container ${container.id} (${container.url})`)

    const originalTenant = container.tenant

    container.tenant = undefined

    return unregisterAndRestartContainer({
      reporter: this.reporter,
      container,
      originalTenant,
      onBeforeRestart,
      onRestart: () => {
        this.busyQueue.flush()
      }
    })
  }
}

async function _findContainer ({
  reporter,
  registry,
  busyQueue,
  maxContainers,
  discriminator,
  options
}) {
  const { onBeforeRestart = async () => {}, onBusy = () => {} } = options
  let container = findTenantContainer(registry, discriminator)

  if (container) {
    if (container.numberOfRequests == null) {
      container.numberOfRequests = 0
    }

    reporter.logger.info(`Reusing existing docker container ${container.id} (${container.url}) (${discriminator})`)

    container.tenant = discriminator
    container.lastUsed = new Date()
    container.numberOfRequests++

    await Promise.resolve(container.restartPromise)

    return container
  }

  reporter.logger.debug(`No docker container previously assigned, searching by LRU, discriminator: ${discriminator}`)

  container = registry.reduce((prev, current) => (prev.lastUsed < current.lastUsed) ? prev : current)

  reporter.logger.debug(`LRU container is ${container.id}`)

  if (container.numberOfRequests == null) {
    container.numberOfRequests = 0
  }

  if (container.numberOfRequests > 0) {
    reporter.logger.info(`All docker containers are busy, queuing work (${discriminator})`)

    return new Promise((resolve, reject) => {
      busyQueue.push(onBusy(), resolve, reject)
    })
  }

  const originalTenant = container.tenant

  container.tenant = discriminator
  container.lastUsed = new Date()

  if (!originalTenant) {
    container.numberOfRequests++

    reporter.logger.info(`No need to restart unassigned docker container ${container.id}`)

    await Promise.resolve(container.restartPromise)

    return container
  }

  reporter.logger.info(`Restarting and unregistering previous assigned docker container ${container.id}`)

  await unregisterAndRestartContainer({
    reporter,
    container,
    originalTenant,
    onBeforeRestart,
    onRestart: () => {
      busyQueue.flush()
    }
  })

  container.numberOfRequests = 1

  return container
}

function findTenantContainer (registry, tenant) {
  return registry.find((c) => {
    return c.tenant != null && c.tenant === tenant
  })
}

async function restart (container) {
  try {
    await container.restart()
  } catch (e) {
    e.message = `Error while re-starting docker container ${container.id} (${container.url}). ${e.message}`
    throw e
  }
}

async function unregisterAndRestartContainer ({
  reporter,
  container,
  originalTenant,
  onBeforeRestart = async () => {},
  onRestart = () => {}
}) {
  container.numberOfRequests = 1

  container.restartPromise = (
    onBeforeRestart(originalTenant)
  ).then(() => restart(container)).catch((e) => {
    reporter.logger.error(`Restarting container ${container.id} (${container.url}) (failed) ${e.stack}`)
    return container
  }).then(() => {
    reporter.logger.info(`Restarting container ${container.id} (${container.url}) (done)`)
    container.numberOfRequests = 0

    onRestart()

    return container
  })

  return container.restartPromise
}

module.exports = (reporter, options) => {
  const registry = []

  const {
    image,
    namePrefix,
    exposedPort,
    basePublishPort,
    network,
    subnet,
    startTimeout,
    restartPolicy,
    restartTimeout,
    maxContainers,
    busyQueue
  } = options

  return {
    get registry () {
      return registry
    },

    async createNetworkForContainers () {
      reporter.logger.debug(`Preparing network ${network} with subnet ${subnet} for docker containers`)

      try {
        await execAsync(`docker network inspect ${network}`)
      } catch (e) {
        try {
          const networkCMD = `docker network create --driver bridge -o com.docker.network.bridge.enable_icc=false --subnet=${subnet} ${network}`

          reporter.logger.debug(`docker network cmd: ${networkCMD}`)

          await execAsync(networkCMD)
        } catch (e) {
          e.message = `Error while creating docker network ${network}: ${e.message}`
          throw e
        }
      }
    },

    async startContainers () {
      const operations = []

      for (let i = 0; i < maxContainers; i++) {
        const container = new Container(reporter, registry, busyQueue, {
          image,
          id: `${namePrefix}${i + 1}`,
          port: basePublishPort + i,
          exposedPort,
          network,
          startTimeout,
          restartPolicy,
          restartTimeout
        })

        registry.push(container)

        reporter.logger.debug(`Starting new docker container ${container.id} (${container.url})`)

        operations.push(container.start())
      }

      try {
        await Promise.all(operations)
      } catch (e) {
        e.message = `Error while creating docker containers: ${e.message}`
        throw e
      }
    },

    async findContainer (discriminator, options) {
      return _findContainer({
        reporter,
        registry,
        busyQueue,
        maxContainers,
        discriminator,
        options
      })
    },

    async removeContainers () {
      const operations = []

      registry.forEach((container) => {
        if (container.restartPromise) {
          operations.push(Promise.resolve(container.restartPromise).then(async () => {
            await execAsync(`docker rm -f ${container.id}`)
            reporter.logger.info(`Removing container ${container.id} (${container.url})`)
          }))
        } else {
          operations.push(execAsync(`docker rm -f ${container.id}`).then(() => {
            reporter.logger.info(`Removing container ${container.id} (${container.url})`)
          }))
        }
      })

      return Promise.all(operations)
    }
  }
}
