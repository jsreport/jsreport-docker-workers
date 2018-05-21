const Promise = require('bluebird')
const get = require('lodash.get')
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

const containers = {}

async function findOrStartContainer (reporter, discriminator) {
  let container = containers[discriminator]

  if (container) {
    reporter.logger.debug(`Reusing existing docker container ${container.id} (${container.url}) (${discriminator})`)

    reporter.logger.debug(`Docker restart ${container.id}`)

    try {
      await execAsync(`docker restart -t 0 ${container.id}`)
    } catch (e) {

    }
  } else {
    const containersCount = Object.keys(containers).length

    container = {
      id: `worker${containersCount + 1}`,
      port: 2000 + containersCount + 1
    }

    const ip = process.env.ip // '192.168.1.2'

    reporter.logger.debug(`local ip ${ip}`)

    container.network = `nw_${container.id}`
    container.url = `http://${ip}:${container.port}`

    containers[discriminator] = container

    reporter.logger.debug(`Preparing network ${container.network} for new docker container ${container.id} (${container.url}) (${discriminator})`)

    try {
      await execAsync(`docker network create --driver bridge -o com.docker.network.bridge.host_binding_ipv4=${ip} ${container.network}`)
    } catch (e) {

    }

    reporter.logger.debug(`Starting new docker container ${container.id} (${container.url}) (${discriminator})`)

    try {
      await execAsync(`docker run -d -p ${container.port}:2000 --network=${container.network} --name ${container.id} --read-only --cap-add=NET_ADMIN worker`)
    } catch (e) {

    }
  }

  return container
}

module.exports = (reporter, definition) => {
  const { discriminatorPath } = definition.options

  reporter.beforeRenderListeners.add('docker-workers', async (req, res) => {
    const discriminator = get(req, discriminatorPath)

    if (discriminator == null) {
      throw reporter.createError(`No value found in request using discriminator "${discriminatorPath}", not possible to delegate requests to docker workers`)
    }

    reporter.logger.debug(`Processing render with discriminator: ${discriminator}`)

    const container = await findOrStartContainer(reporter, discriminator)

    req.context.workerUrl = container.url

    reporter.logger.debug(`Wait for container ${container.id} healthy at ${container.url} (${discriminator})`)

    await waitForPing(container.url)

    reporter.logger.debug(`Container ${container.id} at ${container.url} ready (${discriminator})`)
  })

  reporter.closeListeners.add('docker-workers', async () => {
    // const operations = []
    //
    // Object.keys(containers).forEach((key) => {
    //   const container = containers[key]
    //   operations.push(execAsync(`docker rm -f ${container.id}`))
    // })
    //
    // return Promise.all(operations)
  })
}
