
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
  containerStartTimeout,
  containerRestartPolicy,
  containerRestartTimeout,
  subnet,
  network,
  busyQueueWaitingTimeout,
  maxContainers
}) => {
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

  const containersManager = createContainersManager({
    hostIp: ip,
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
    logger: reporter.logger
  })

  const executeInWorker = createExecuteInWorker({
    reporter, containersManager, ip, stack, serversChecker, discriminatorPath
  })

  const delegate = createDelegate(reporter)

  function onSIGTERM () {
    reporter.logger.info(`Quiting worker, unsetting tenants with in worker ${ip} ${stack}`)

    function exit () {
      process.exit()
    }

    reporter.documentStore.collection('tenantWorkers').remove({
      ip,
      stack
    }).then(exit, exit)
  }

  process.on('SIGTERM', onSIGTERM)

  async function executeScript (inputs, options, req) {
    return executeInWorker(req, (worker) => delegate.delegateScript(worker.url, worker.remote, inputs, options, req))
  }

  async function executeRecipe (recipe, req, res, fromRemote) {
    return executeInWorker(req, (worker) => delegate.delegateRecipe(worker.url, worker.remote, recipe, req, res, fromRemote))
  }

  return {
    serversChecker,
    containersManager,
    executeScript,
    executeRecipe,
    async init () {
      await serversChecker.startPingInterval()
      await serversChecker.startStatusInterval()
      await containersManager.start()
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
