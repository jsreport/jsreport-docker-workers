
async function doPing (reporter, ip, stack) {
  return reporter.documentStore.collection('servers').update({
    ip,
    stack
  }, {
    $set: {
      ping: new Date(),
      stack
    }
  }, { upsert: true })
}

async function refreshServersCache (reporter, stack) {
  return reporter.documentStore.collection('servers').find({ stack }).toArray()
}

module.exports = (reporter, { ip, stack, pingInterval, healthyInterval }) => {
  let cache = []

  return {
    async startPingInterval () {
      setInterval(async () => {
        try {
          await doPing(reporter, ip, stack)
        } catch (e) {
          reporter.logger.error(`Error while doing ping (interval) to server ${ip} - ${stack}: ${e.message}`)
        }
      }, pingInterval).unref()

      try {
        await doPing(reporter, ip, stack)
      } catch (e) {
        reporter.logger.error(`Error at start ping to server ${ip} - ${stack}: ${e.message}`)
        throw e
      }
    },

    async startStatusInterval () {
      setInterval(async () => {
        try {
          cache = await refreshServersCache(reporter, stack)
        } catch (e) {
          reporter.logger.error(`Error while getting status (interval) of servers ${stack}: ${e.message}`)
        }
      }, pingInterval).unref()

      try {
        cache = await refreshServersCache(reporter, stack)
      } catch (e) {
        reporter.logger.error(`Error at start of getting status of servers ${stack}: ${e.message}`)
        throw e
      }
    },

    async ping (workerIp, workerStack) {
      return doPing(reporter, workerIp, workerStack)
    },

    status (workerIp) {
      const server = cache.find((s) => s.ip === workerIp)

      return server && server.ping > new Date(Date.now() - healthyInterval)
    }
  }
}
