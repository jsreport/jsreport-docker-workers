const createContainersPool = require('./docker/containersPool')
const createBusyQueue = require('./busyQueue')

module.exports = ({
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
  busyQueueWaitingTimeout,
  logger,
  predefinedContainersPool
}) => {
  const containersPool = predefinedContainersPool || createContainersPool({
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
    logger
  })

  let onRecycle = () => {}

  const busyQueue = createBusyQueue({
    run: (...args) => allocate(...args),
    waitingTimeout: busyQueueWaitingTimeout,
    logger: logger
  })

  async function allocate ({req, tenant}) {
    let container = containersPool.containers.find((c) => c.tenant != null && c.tenant === tenant)
    if (container) {
      logger.info(`Reusing existing docker container ${container.id} (${container.url}) (${tenant})`)

      container.tenant = tenant
      container.lastUsed = new Date()
      container.numberOfRequests++

      return container
    }

    logger.debug(`No docker container previously assigned, searching by LRU, discriminator: ${tenant}`)
    // make sure we get the first container for brand new containers
    container = containersPool.containers.reduce((prev, current) =>
      (prev.lastUsed < current.lastUsed || (!prev.lastUsed && !current.lastUsed)) ? prev : current)
    logger.debug(`LRU container is ${container.id}`)

    if (container.numberOfRequests > 0) {
      logger.info(`All docker containers are busy, queuing work (${tenant})`)

      return new Promise((resolve, reject) => {
        busyQueue.push({ discriminator: tenant,
          req
        }, resolve, reject)
      })
    }

    const originalTenant = container.tenant

    container.tenant = tenant
    container.lastUsed = new Date()

    if (!originalTenant) {
      container.numberOfRequests++

      logger.info(`No need to restart unassigned docker container ${container.id}`)
      return container
    }

    logger.info(`Restarting and unregistering previous assigned docker container ${container.id}`)

    await recycle({
      container,
      originalTenant
    })

    container.numberOfRequests = 1

    return container
  }

  async function warmupNextOldContainer () {
    const container = containersPool.containers.reduce((prev, current) => (prev.lastUsed < current.lastUsed) ? prev : current)

    if (!container || container.numberOfRequests > 0 || !container.tenant) {
      return
    }

    logger.info(`Warming up docker container ${container.id} (${container.url})`)

    const originalTenant = container.tenant

    container.tenant = undefined

    return recycle({
      container,
      originalTenant
    })
  }

  async function recycle ({ container, originalTenant }) {
    if (container.restartPromise) {
      return container.restartPromise
    }

    // no one should use this container now
    container.numberOfRequests = 1
    container.tenant = undefined
    container.numberOfRestarts++

    container.restartPromise = Promise.resolve(onRecycle({ container, originalTenant })).then(() => container.restart()).catch((e) => {
      logger.error(`Restarting container ${container.id} (${container.url}) (failed) ${e.stack}`)
      return container
    }).then(() => {
      logger.info(`Restarting container ${container.id} (${container.url}) (done)`)
      container.numberOfRequests = 0
      container.restartPromise = null

      busyQueue.flush()

      return container
    })

    return container.restartPromise
  }

  async function release (container) {
    container.numberOfRequests--
    busyQueue.flush()

    warmupNextOldContainer()
  }

  return {
    containers: containersPool.containers,
    busyQueue: busyQueue,
    async start () {
      await containersPool.start()
      containersPool.containers.forEach((c) => {
        c.numberOfRequests = 0
        c.numberOfRestarts = 0
      })
    },
    close () {
      return containersPool.remove()
    },
    allocate,
    recycle,
    release,
    onRecycle (fn) {
      onRecycle = fn
    }
  }
}
