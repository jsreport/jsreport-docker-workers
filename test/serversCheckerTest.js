const jsreport = require('jsreport-core')
const should = require('should')

describe('servers checker', () => {
  let reporter

  beforeEach(() => {
    return (reporter = jsreport({
      store: {
        provider: 'fs'
      },
      extensions: {
        workerDockerManager: {
          numberOfWorkers: 1,
          pingInterval: 10,
          discriminatorPath: 'context.tenant'
        },
        fsStore: {
          dataDirectory: 'temp'
        }
      }
    })).use(require('../')()).use(require('jsreport-fs-store')()).init()
  })

  afterEach(() => reporter.close())

  it('current server should have ok status', () => reporter.dockerManager.serversChecker.status(reporter.options.ip).should.be.ok())
  it('not existing server should have false status', () => should(reporter.dockerManager.serversChecker.status('foo')).not.be.ok())

  it('current server should not be ok for healthyInterval 0', () => {
    reporter.dockerManager.serversChecker.healthyInterval = 0
    should(reporter.dockerManager.serversChecker.status('0.0.0.0')).not.be.ok()
  })
})
