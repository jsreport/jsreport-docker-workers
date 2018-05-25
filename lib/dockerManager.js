
const get = require('lodash.get')
const createContainersManager = require('./containersManager')
const createServersChecker = require('./serversChecker')
const createBusyQueue = require('./busyQueue')

module.exports = (reporter, definition) => {
  if (!reporter.workerDelagate) {
    throw new Error(
      'worker-docker-manager extension needs to be used with worker-delegate extension, make sure to install worker-delegate extension first'
    )
  }

  const {
    ipEnvVarName,
    stackEnvVarName,
    discriminatorPath,
    pingServersInterval,
    pingHealthyInterval,
    containerImage,
    containerNamePrefix,
    containerExposedPort,
    containerBasePublishPort,
    containerStartTimeout,
    containerRestartPolicy,
    containerRestartTimeout,
    subnet,
    network,
    busyQueueWaitingTimeout,
    maxContainers
  } = definition.options

  const ip = process.env[ipEnvVarName]
  const stack = process.env[stackEnvVarName]

  const serversChecker = createServersChecker(reporter, {
    ip,
    stack,
    pingInterval: pingServersInterval,
    healthyInterval: pingHealthyInterval
  })

  const busyQueue = createBusyQueue(reporter, {
    run: getContainer,
    waitingTimeout: busyQueueWaitingTimeout
  })

  const containersManager = createContainersManager(reporter, {
    image: containerImage,
    namePrefix: containerNamePrefix,
    exposedPort: containerExposedPort,
    basePublishPort: containerBasePublishPort,
    startTimeout: containerStartTimeout,
    restartTimeout: containerRestartTimeout,
    restartPolicy: containerRestartPolicy,
    subnet,
    network,
    maxContainers,
    busyQueue
  })

  reporter.workerDelagate.getWorker = async (req) => {
    const discriminator = get(req, discriminatorPath)

    if (discriminator == null) {
      throw reporter.createError(`No value found in request using discriminator "${discriminatorPath}", not possible to delegate requests to docker workers`)
    }

    function onBeforeRestart (tenant) {
      const update = { $set: {} }

      // update.$set[`workerIp.${process.env.stack}`] = undefined

      return reporter.documentStore.collection('tenants').update({
        id: tenant
      }, update)
    }

    const input = {
      reporter,
      containersManager,
      serversChecker,
      discriminator,
      req,
      options: {
        ip,
        stack,
        onBeforeRestart,
        onBusy: () => input
      }
    }

    const container = await getContainer(input)

    if (!container) {
      throw new Error('No container returned from route logic')
    }

    return {
      url: container.url,
      release: async (err) => {
        if (err) {
          await container.release(discriminator, onBeforeRestart)
          return
        }

        await container.release(discriminator)
      }
    }
  }

  reporter.documentStore.registerEntityType('ServerType', {
    _id: { type: 'Edm.String', key: true },
    ip: { type: 'Edm.String', publicKey: true },
    stack: { type: 'Edm.String' },
    ping: { type: 'Edm.DateTimeOffset' }
  })

  reporter.documentStore.registerEntitySet('servers', {
    entityType: 'jsreport.ServerType',
    humanReadableKey: 'ip',
    // TODO: this property is added just for now to avoid authorization extension
    // to register listener in the collection
    shared: true
  })

  reporter.documentStore.registerComplexType('TenantWorkerIpRefType', {
    'stack': { type: 'Edm.String' },
    'ip': { type: 'Edm.String' }
  })

  reporter.documentStore.registerEntityType('TenantType', {
    _id: { type: 'Edm.String', key: true },
    id: { type: 'Edm.String', publicKey: true },
    workerIp: { type: 'Collection(jsreport.TenantWorkerIpRefType)' },
    createdAt: { type: 'Edm.DateTimeOffset' }
  })

  reporter.documentStore.registerEntitySet('tenants', {
    entityType: 'jsreport.ServerType',
    humanReadableKey: 'ip',
    // TODO: this property is added just for now to avoid authorization extension
    // to register listener in the collection
    shared: true
  })

  reporter.initializeListeners.add('docker-workers', async () => {
    await serversChecker.startPingInterval()
    await serversChecker.startStatusInterval()
    await containersManager.createNetworkForContainers()
  })

  reporter.closeListeners.add('docker-workers', async () => {
    try {
      await containersManager.removeContainers()
    } catch (e) {
      reporter.logger.error(`Error while trying to remove containers: ${e.message}`)
    }
  })
}

async function getContainer ({
  reporter,
  containersManager,
  serversChecker,
  discriminator,
  req,
  options
}) {
  const { ip, stack, onBeforeRestart, onBusy } = options

  reporter.logger.debug(`Processing render with discriminator: ${discriminator}`, req)

  let currentTenant = await reporter.documentStore.collection('tenants').findOne({
    id: discriminator
  }, { workerIp: 1 })

  if (!currentTenant) {
    reporter.logger.debug(`Creating new tenant with id ${discriminator}`, req)

    currentTenant = await reporter.documentStore.collection('tenants').update({
      id: discriminator
    }, {
      $set: {
        createdAt: new Date()
      }
    }, { upsert: true })
  }

  if (currentTenant.workerIp) {
    const ipInStack = findIpInStack(currentTenant.workerIp, stack)

    if (ipInStack != null && ipInStack !== ip && serversChecker.status(ipInStack)) {
      reporter.logger.info(`Posting to external worker ${ipInStack}, discriminator: ${discriminator}`, req)

      const serverPort = reporter.express.server.address().port

      // TODO: complete delegation of render request to different worker
      return
      // return axios.post(`http://${ipInStack}:${serverPort}`, {
      //
      // })
    }
  }

  const update = { $set: {} }

  update.$set.workerIp = currentTenant.workerIp != null ? [...currentTenant.workerIp] : []

  saveIp(update.$set.workerIp, stack, ip)

  await reporter.documentStore.collection('tenants').update({
    id: discriminator
  }, update)

  reporter.logger.info(`Executing in local worker, discriminator: ${discriminator}`, req)

  try {
    const container = await containersManager.findOrStartContainer(
      discriminator,
      {
        onBeforeRestart,
        onBusy
      }
    )

    reporter.logger.debug(`Wait for container ${container.id} healthy at ${container.url} (${discriminator})`, req)

    await container.waitForPing()

    reporter.logger.debug(`Container ${container.id} at ${container.url} ready (${discriminator})`, req)

    return container
  } catch (e) {
    e.message = `Error while trying to prepare docker container for render request. ${e.message}`
    throw e
  }
}

function findIpInStack (workerIp, stack) {
  if (!Array.isArray(workerIp)) {
    return
  }

  const w = workerIp.find((w) => w.stack === stack)

  if (w) {
    return w.ip
  }

  return w
}

function saveIp (workerIp, stack, ip) {
  const foundIndex = workerIp.findIndex((w) => {
    return w.stack === stack
  })

  if (foundIndex === -1) {
    workerIp.push({
      stack,
      ip
    })
  } else {
    workerIp[foundIndex].ip = ip
  }
}
