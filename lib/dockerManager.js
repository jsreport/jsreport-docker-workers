
const get = require('lodash.get')
const uuid = require('uuid')
const axios = require('axios')
const createContainersManager = require('./containersManager')
const createServersChecker = require('./serversChecker')
const createBusyQueue = require('./busyQueue')

module.exports = (reporter, definition) => {
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

  if (!ip) {
    throw new Error(`No "ip" value defined in env var "${ipEnvVarName}", you need to set this env var before starting the app`)
  }

  if (!stack) {
    throw new Error(`No "stack" value defined in env var "${stackEnvVarName}", you need to set this env var before starting the app`)
  }

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

  reporter.documentStore.registerEntityType('ServerType', {
    ip: { type: 'Edm.String', key: true, publicKey: true },
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

  reporter.documentStore.registerEntityType('TenantWorkers', {
    _id: { type: 'Edm.String', key: true, publicKey: true },
    ip: { type: 'Edm.String' },
    port: { type: 'Edm.Int32' },
    stack: { type: 'Edm.String' },
    tenant: { type: 'Edm.String' },
    updateAt: { type: 'Edm.DateTimeOffset' }
  })

  reporter.documentStore.registerEntitySet('tenantWorkers', {
    entityType: 'jsreport.TenantWorkers',
    humanReadableKey: '_id',
    // TODO: this property is added just for now to avoid authorization extension
    // to register listener in the collection
    shared: true
  })

  reporter.executeScript = executeScript

  reporter.initializeListeners.add('docker-workers', async () => {
    reporter.extensionsManager.recipes = reporter.extensionsManager.recipes.map((r) => ({
      name: r.name,
      execute: (req, res) => {
        return executeRecipe(r.name, req, res)
      }
    }))

    await serversChecker.startPingInterval()
    await serversChecker.startStatusInterval()
    await containersManager.createNetworkForContainers()
    await containersManager.startContainers()
  })

  reporter.on('after-authentication-express-routes', () => {
    return reporter.express.app.post('/api/worker-docker-manager', dockerManagerRequestHandler)
  })

  reporter.on('after-express-static-configure', () => {
    if (!reporter.authentication) {
      return reporter.express.app.post('/api/worker-docker-manager', dockerManagerRequestHandler)
    }
  })

  function onSIGTERM () {
    reporter.logger.info(`Quiting worker, unsetting tenants with in worker ${ip} ${stack}`)

    function onFinish () {
      process.exit()
    }

    reporter.documentStore.collection('tenantWorkers').remove({
      ip,
      stack
    }).then(onFinish, onFinish)
  }

  process.on('SIGTERM', onSIGTERM)

  reporter.closeListeners.add('docker-workers', async () => {
    try {
      process.removeListener('SIGTERM', onSIGTERM)
      serversChecker.stopPingInterval()
      serversChecker.stopStatusInterval()
      await containersManager.removeContainers()
    } catch (e) {
      reporter.logger.error(`Error while trying to remove containers: ${e.message}`)
    }
  })

  reporter.dockerManager = {
    serversChecker,
    containersManager
  }

  async function getWorker (req) {
    const discriminator = get(req, discriminatorPath)

    if (discriminator == null) {
      throw reporter.createError(`No value found in request using discriminator "${discriminatorPath}", not possible to delegate requests to docker workers`)
    }

    function onBeforeRestart (tenant) {
      return reporter.documentStore.collection('tenantWorkers').remove({
        ip,
        stack,
        tenant: tenant
      })
    }

    const input = {
      discriminator,
      req,
      onBeforeRestart,
      onBusy: () => input
    }

    const container = await getContainer(input)

    if (!container) {
      throw new Error('No container returned from route logic')
    }

    if (container.remote === true) {
      return container
    }

    return {
      url: container.url,
      release: async (err) => {
        if (err) {
          await container.release(discriminator, onBeforeRestart, true)
          return
        }

        await container.release(discriminator, onBeforeRestart)
      }
    }
  }

  async function getContainer ({
    discriminator,
    req,
    onBeforeRestart,
    onBusy
  }) {
    const serverPort = reporter.express.server.address().port

    reporter.logger.debug(`Processing render with discriminator: ${discriminator}`)

    let currentTenantWorker = await reporter.documentStore.collection('tenantWorkers').findOne({
      stack,
      tenant: discriminator
    })

    if (currentTenantWorker && currentTenantWorker.ip != null && currentTenantWorker.ip !== ip) {
      reporter.logger.debug(`Found previous remote worker assigned ${currentTenantWorker.ip}, checking status`)

      if (serversChecker.status(currentTenantWorker.ip)) {
        const remotePort = currentTenantWorker.port != null ? currentTenantWorker.port : serverPort
        const remoteUrl = `http://${currentTenantWorker.ip}:${remotePort}/api/worker-docker-manager`

        reporter.logger.info(`Delegating request to external worker ${currentTenantWorker.ip} (${remoteUrl}), discriminator: ${discriminator}`)

        return {
          remote: true,
          url: remoteUrl
        }
      }

      reporter.logger.debug(`Remote worker ${currentTenantWorker.ip} is not healthy, continuing request in local`)
    }

    await reporter.documentStore.collection('tenantWorkers').update({
      stack,
      tenant: discriminator
    }, { $set: { ip, port: serverPort, stack, tenant: discriminator, updateAt: new Date() } }, { upsert: true })

    reporter.logger.info(`Executing in local worker, discriminator: ${discriminator}`)

    try {
      const container = await containersManager.findContainer(
        discriminator,
        {
          onBeforeRestart,
          onBusy
        }
      )

      reporter.logger.debug(`Wait for container ${container.id} healthy at ${container.url} (${discriminator})`)

      await container.waitForPing()

      reporter.logger.debug(`Container ${container.id} at ${container.url} ready (${discriminator})`)

      return container
    } catch (e) {
      e.message = `Error while trying to prepare docker container for render request. ${e.message}`
      throw e
    }
  }

  async function dockerManagerRequestHandler (req, res, next) {
    try {
      const type = req.body.type
      const reqInput = req.body.data
      const jsreportReq = reqInput.req

      // we need to define __isJsreportRequest__ to avoid error in render
      // from parent request
      Object.defineProperty(jsreportReq, '__isJsreportRequest__', {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false
      })

      if (type === 'scriptManager') {
        const scriptResult = await executeScript(
          reqInput.inputs,
          reqInput.options,
          jsreportReq
        )

        return res.json(scriptResult)
      }

      if (type === 'recipe') {
        const recipeResult = await executeRecipe(
          reqInput.recipe,
          jsreportReq,
          reqInput.res,
          true
        )

        return res.json({
          req: recipeResult.req,
          res: recipeResult.res
        })
      }

      throw new Error(`Unsuported worker action type ${type}`)
    } catch (e) {
      res.status(400).json({
        message: e.message,
        stack: e.stack
      })
    }
  }

  async function executeScript (inputs, options, req) {
    const worker = await getWorker(req)

    if (!worker || worker.url == null) {
      throw new Error(`Worker obtained has no url assigned to execute script in it`)
    }

    if (worker.remote === true) {
      reporter.logger.debug(`Delegating script to external worker at ${worker.url}`)
    } else {
      reporter.logger.debug(`Delegating script to container in local worker at ${worker.url}`)
    }

    let resp

    try {
      const requestInput = {
        type: 'scriptManager',
        data: {
          inputs,
          options
        }
      }

      if (worker.remote === true) {
        requestInput.data.req = req
      } else {
        requestInput.uuid = uuid()
      }

      const reqOptions = {}

      if (worker.remote === true && reporter.authentication) {
        const authOptions = reporter.options.extensions.authentication

        reqOptions.auth = {
          username: authOptions.admin.username,
          password: authOptions.admin.password
        }
      }

      resp = await axiosPost(worker.url, requestInput, reqOptions)
    } catch (e) {
      if (!worker.remote) {
        await worker.release(e)
      }

      throw e
    }

    if (!worker.remote) {
      await worker.release()
    }

    return resp.data
  }

  async function executeRecipe (recipe, req, res, fromRemote) {
    const worker = await getWorker(req)

    if (!worker || worker.url == null) {
      throw new Error(`Worker obtained has no url assigned to execute recipe in it`)
    }

    return delegateRecipe(worker, recipe, req, res, fromRemote)
  }

  async function delegateRecipe (worker, recipe, req, res, fromRemote) {
    const url = worker.url

    if (worker.remote === true) {
      reporter.logger.debug(`Delegating recipe ${recipe} to external worker at ${url}`)
    } else {
      reporter.logger.debug(`Delegating recipe ${recipe} to container in local worker at ${url}`)
      req.context.uuid = uuid()
    }

    // jsreport has in content buffer which is harder to serialize
    // but we can send already string to the worker
    res.content = res.content.toString()

    const requestInput = {
      type: 'recipe',
      data: {
        recipe,
        req,
        res
      }
    }

    let resp

    if (worker.remote === true) {
      const reqOptions = {}

      if (reporter.authentication) {
        const authOptions = reporter.options.extensions.authentication

        reqOptions.auth = {
          username: authOptions.admin.username,
          password: authOptions.admin.password
        }
      }

      resp = await axiosPost(url, requestInput, reqOptions)
    } else {
      requestInput.uuid = req.context.uuid

      try {
        resp = await axiosPost(url, requestInput)

        while (resp.data.action === 'render') {
          const respBody = resp.data

          Object.assign(req, respBody.data.parentReq)
          reporter.logger.debug(`Processing render callback from worker`)

          const renderRes = await reporter.render(respBody.data.req, req)

          resp = await axiosPost(url, {
            uuid: req.context.uuid,
            data: {
              content: renderRes.content.toString(),
              req
            }
          })
        }
      } catch (e) {
        if (!worker.remote) {
          await worker.release(e)
        }

        throw e
      }
    }

    Object.assign(req, resp.data.req)
    Object.assign(res, resp.data.res)

    res.content = Buffer.from(res.content, 'base64')

    if (!worker.remote) {
      await worker.release()
    }

    if (fromRemote === true) {
      return {
        req,
        res
      }
    }
  }

  async function axiosPost (url, data, opts) {
    try {
      return await axios.post(url, data, opts)
    } catch (e) {
      if (e.response && e.response.status === 400 && e.response.data && e.response.data.message) {
        const error = reporter.createError(e.response.data.message, {
          weak: true
        })

        error.stack = e.response.data.stack
        throw error
      }

      throw e
    }
  }
}
