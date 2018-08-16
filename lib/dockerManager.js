
const ListenerCollection = require('listener-collection')
const createContainersManager = require('./containersManager')
const createServersChecker = require('./serversChecker')
const createDelegate = require('./delegate')
const createExecuteInWorker = require('./executeInWorker')

module.exports = (reporter, {
  ipEnvVarName,
  stackEnvVarName,
  discriminatorPath,
  pingServersInterval,
  pingHealthyInterval,
  containerImage,
  containerNamePrefix,
  containerExposedPort,
  containerBasePublishPort,
  containerCustomEnv,
  containerStartTimeout,
  containerRestartPolicy,
  containerRestartTimeout,
  containerDebuggingSession,
  containerDelegateTimeout,
  containerMemory,
  containerMemorySwap,
  containerCPUs,
  subnet,
  network,
  busyQueueWaitingTimeout,
  maxContainers
}) => {
  const ip = process.env[ipEnvVarName]
  const stack = process.env[stackEnvVarName]

  const containerDelegateErrorListeners = new ListenerCollection()
  const containerDelegateRequestFilterListeners = new ListenerCollection()
  const containerDelegateResponseFilterListeners = new ListenerCollection()

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

  const containersManager = createContainersManager({
    debuggingSession: containerDebuggingSession,
    hostIp: ip,
    image: containerImage,
    namePrefix: containerNamePrefix,
    exposedPort: containerExposedPort,
    basePublishPort: containerBasePublishPort,
    customEnv: containerCustomEnv,
    startTimeout: containerStartTimeout,
    restartTimeout: containerRestartTimeout,
    restartPolicy: containerRestartPolicy,
    memory: containerMemory,
    memorySwap: containerMemorySwap,
    cpus: containerCPUs,
    subnet,
    network,
    maxContainers,
    logger: reporter.logger
  })

  const executeInWorker = createExecuteInWorker({
    reporter, containersManager, ip, stack, serversChecker, discriminatorPath
  })

  const delegate = createDelegate(reporter, {
    delegateTimeout: containerDelegateTimeout,
    onRequestFilter: async (type, originalReq, reqData, meta) => {
      const pipe = {
        type,
        req: originalReq,
        data: reqData,
        meta
      }

      await containerDelegateRequestFilterListeners.fire(pipe)

      return pipe.data
    },
    onResponseFilter: async (type, originalReq, resData, meta) => {
      const pipe = {
        type,
        req: originalReq,
        data: resData,
        meta
      }

      await containerDelegateResponseFilterListeners.fire(pipe)

      return pipe.data
    },
    onContainerError: async (params) => {
      return containerDelegateErrorListeners.fire(params)
    }
  })

  function onSIGTERM () {
    reporter.logger.info(`Quiting worker, unsetting tenants with in worker ${ip} ${stack}`)

    function exit () {
      process.exit()
    }

    reporter.documentStore.internalCollection('tenantWorkers').remove({
      ip,
      stack
    }).then(exit, exit)
  }

  process.on('SIGTERM', onSIGTERM)

  async function executeScript (inputs, options, req, fromRemote) {
    return executeInWorker(req, (worker) => delegate.delegateScript(worker.url, worker.remote, inputs, options, req, fromRemote))
  }

  async function executeRecipe (recipe, req, res, fromRemote) {
    return executeInWorker(req, (worker) => delegate.delegateRecipe(worker.url, worker.remote, recipe, req, res, fromRemote))
  }

  return {
    serversChecker,
    containersManager,
    executeScript,
    executeRecipe,
    addContainerDelegateRequestFilterListener (name, fn) {
      containerDelegateRequestFilterListeners.add(name, async (opts) => {
        // logic to filter request data shape through listeners
        const { type, req, data, meta } = opts

        const customData = await fn(type, req, data, meta)

        if (customData != null) {
          opts.data = customData
        }
      })
    },
    removeContainerDelegateRequestFilterListener (...args) { containerDelegateRequestFilterListeners.remove(...args) },
    addContainerDelegateResponseFilterListener (name, fn) {
      containerDelegateResponseFilterListeners.add(name, async (opts) => {
        // logic to filter response data shape through listeners
        const { type, req, data, meta } = opts

        const customData = await fn(type, req, data, meta)

        if (customData != null) {
          opts.data = customData
        }
      })
    },
    removeContainerDelegateResponseFilterListener (...args) { containerDelegateResponseFilterListeners.remove(...args) },
    addContainerDelegateErrorListener (...args) { containerDelegateErrorListeners.add(...args) },
    removeContainerDelegateErrorListener (...args) { containerDelegateErrorListeners.remove(...args) },
    async init () {
      await serversChecker.startPingInterval()
      await serversChecker.startStatusInterval()
      await containersManager.start()
      reporter.logger.debug(`docker manager initialized correctly`)
    },
    async close () {
      try {
        process.removeListener('SIGTERM', onSIGTERM)
        serversChecker.stopPingInterval()
        serversChecker.stopStatusInterval()
        await containersManager.close()
      } catch (e) {
        reporter.logger.error(`Error while trying to remove containers: ${e.message}`)
      }
    }
  }
}
