const get = require('lodash.get')

module.exports = ({ reporter, containersManager, ip, stack, serversChecker, discriminatorPath }) => {
  containersManager.onRecycle(({ container, originalTenant }) => {
    return reporter.documentStore.internalCollection('tenantWorkers').remove({
      ip,
      stack,
      tenant: originalTenant
    })
  })

  async function allocateWorker ({
    discriminator,
    req
  }) {
    reporter.logger.debug(`Processing render with discriminator: ${discriminator}`)
    const serverPort = reporter.express.server.address().port

    let currentTenantWorker = await reporter.documentStore.internalCollection('tenantWorkers').findOne({
      stack,
      tenant: discriminator
    })

    if (
      currentTenantWorker &&
      (currentTenantWorker.ip !== ip ||
      (currentTenantWorker.ip === ip && currentTenantWorker.port !== serverPort))
    ) {
      reporter.logger.debug(`Found previous remote worker assigned ${currentTenantWorker.ip} (port: ${currentTenantWorker.port}), checking status`)

      if (serversChecker.status(currentTenantWorker.ip)) {
        const remoteUrl = `http://${currentTenantWorker.ip}:${currentTenantWorker.port}/api/worker-docker-manager`

        reporter.logger.info(`Delegating request to external worker ${currentTenantWorker.ip} (${remoteUrl}), discriminator: ${discriminator}`)

        return {
          remote: true,
          url: remoteUrl
        }
      }

      reporter.logger.debug(`Remote worker ${currentTenantWorker.ip} (port: ${currentTenantWorker.port}) is not healthy, continuing request in local`)
    }

    await reporter.documentStore.internalCollection('tenantWorkers').update({
      stack,
      tenant: discriminator
    }, { $set: { ip, port: serverPort, stack, tenant: discriminator, updateAt: new Date() } }, { upsert: true })

    reporter.logger.info(`Executing in local worker, port: ${serverPort}, discriminator: ${discriminator}`)

    try {
      const container = await containersManager.allocate({ req, tenant: discriminator })

      reporter.logger.debug(`Wait for container ${container.id} healthy at ${container.url} (${discriminator})`)

      reporter.logger.debug(`Container ${container.id} at ${container.url} ready (${discriminator})`)

      return container
    } catch (e) {
      e.message = `Error while trying to prepare docker container for render request. ${e.message}`
      throw e
    }
  }

  return async (req, fn) => {
    const discriminator = get(req, discriminatorPath)

    if (discriminator == null) {
      throw reporter.createError(`No value found in request using discriminator "${discriminatorPath}", not possible to delegate requests to docker workers`)
    }

    const container = await allocateWorker({
      discriminator,
      req
    })

    let result

    try {
      result = await fn(container)
    } catch (e) {
      if (container.remote !== true) {
        reporter.logger.debug(`Releasing docker container (and restarting) ${container.id} (${container.url})`)

        containersManager.recycle({ container, originalTenant: discriminator }).catch((err) => {
          reporter.logger.error(`Error while trying to recycle container ${container.id} (${container.url}): ${err.stack}`)
        })
      } else {
        reporter.logger.debug(`Release of used docker container was handled in remote worker`)
      }

      throw e
    }

    if (container.remote !== true) {
      reporter.logger.debug(`Releasing docker container ${container.id} (${container.url})`)
      await containersManager.release(container)
    }

    return result
  }
}
