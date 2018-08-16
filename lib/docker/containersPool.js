
const Promise = require('bluebird')
const execAsync = Promise.promisify(require('child_process').exec)
const Container = require('./container')

module.exports = ({
  debuggingSession,
  hostIp,
  image,
  namePrefix,
  exposedPort,
  basePublishPort,
  customEnv,
  network,
  subnet,
  startTimeout,
  restartPolicy,
  restartTimeout,
  maxContainers,
  memory,
  memorySwap,
  cpuQuota,
  logger
}) => {
  const containers = []

  return {
    get containers () {
      return containers
    },

    async createNetworkForContainers () {
      logger.debug(`Preparing network ${network} with subnet ${subnet} for docker containers`)

      try {
        await execAsync(`docker network inspect ${network}`)
      } catch (e) {
        try {
          const networkCMD = `docker network create --driver bridge -o com.docker.network.bridge.enable_icc=false --subnet=${subnet} ${network}`

          logger.debug(`docker network cmd: ${networkCMD}`)

          await execAsync(networkCMD)
        } catch (e) {
          e.message = `Error while creating docker network ${network}: ${e.message}`
          throw e
        }
      }
    },

    async start () {
      await this.createNetworkForContainers()

      const operations = []

      for (let i = 0; i < maxContainers; i++) {
        const container = new Container({
          debuggingSession,
          hostIp,
          image,
          id: `${namePrefix}${i + 1}`,
          idx: i,
          port: basePublishPort + i,
          exposedPort,
          customEnv,
          network,
          startTimeout,
          restartPolicy,
          restartTimeout,
          memory,
          memorySwap,
          cpuQuota,
          logger
        })

        containers.push(container)

        logger.debug(`Starting new docker container ${container.id} (${container.url})`)

        operations.push(container.start())
      }

      try {
        await Promise.all(operations)
      } catch (e) {
        e.message = `Error while creating docker containers: ${e.message}`
        throw e
      }
    },

    async remove () {
      const operations = []

      containers.forEach((container) => {
        if (container.restartPromise) {
          operations.push(Promise.resolve(container.restartPromise).then(async () => {
            await execAsync(`docker rm -f ${container.id}`)
            logger.info(`Removing container ${container.id} (${container.url})`)
          }))
        } else {
          operations.push(execAsync(`docker rm -f ${container.id}`).then(() => {
            logger.info(`Removing container ${container.id} (${container.url})`)
          }))
        }
      })

      return Promise.all(operations)
    }
  }
}
