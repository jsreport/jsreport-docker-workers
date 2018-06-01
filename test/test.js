
const path = require('path')
const should = require('should')
const parsePdf = require('parse-pdf')
const jsreport = require('jsreport-core')
const extend = require('node.extend')
const utils = require('./utils')

const IS_LINUX = process.platform === 'linux'
const hostIp = process.env.hostIp
const ip = '0.0.0.0'
const stack = 'test'
const testTenant = 'testTenant'

process.env.ip = ip
process.env.stack = stack

function createReporterInstance (customOptions = {}, authEnabled) {
  const options = extend(true, {
    allowLocalFilesAccess: true,
      templatingEngines: { strategy: 'in-process', timeout: 70000000 },
    extensions: {
      'worker-docker-manager': {
        maxContainers: 2
      }
    }
  }, customOptions)

  if (authEnabled) {
    options.extensions = options.extensions || {}
    options.extensions.authentication = options.extensions.authentication || {}
    options.extensions.authentication.cookieSession = options.extensions.authentication.cookieSession || {}
    options.extensions.authentication.enabled = true
    options.extensions.authentication.admin = { username: 'admin', password: '1234' }
    options.extensions.authentication.cookieSession.secret = '<some secret>'
  }

  const instance = jsreport(options)

  instance
    .use({
      name: 'app',
      directory: __dirname,
      main: (reporter, definition) => {
        reporter.beforeRenderListeners.add('app', async (req, res) => {
          req.context.tenant = testTenant
        })
      }
    })
    .use(require('jsreport-fs-store')())
    .use(require('jsreport-express')())
    .use(require('jsreport-chrome-pdf')())
    .use(require('jsreport-handlebars')())
    .use(require('jsreport-scripts')())

  if (authEnabled) {
    instance.use(require('jsreport-authentication')())
  }

  instance.use(require('../')({
    discriminatorPath: 'context.tenant'
  }))

  return instance
}

function addLogsRewriter (reporter, logs) {
  const foundIndex = reporter.logger.rewriters.findIndex((r) => r.customRewriterForTest === true)

  // avoid creating a leak of rewriters
  if (foundIndex !== -1) {
    reporter.logger.rewriters.splice(foundIndex, 1)
  }

  const rewriter = (level, msg, meta) => {
    logs.push(msg)
    return meta
  }

  rewriter.customRewriterForTest = true

  reporter.logger.rewriters.push(rewriter)
}

describe('docker render', () => {
  let reporter
  let logs = []

  beforeEach(async () => {
    logs = []

    reporter = createReporterInstance()

    await reporter.init()

    addLogsRewriter(reporter, logs)
  })

  afterEach(async () => {
    if (reporter) {
      await reporter.close()
    }
  })

  it('should render', async () => {
    const res = await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'html',
        engine: 'handlebars'
      },
      data: {
        foo: 'hello'
      }
    })

    res.content.toString().should.be.eql('hello')
  })

  it('should render chrome-pdf in worker', async () => {
    const res = await reporter.render({
      template: {
        content: 'foo',
        recipe: 'chrome-pdf',
        engine: 'none'
      }
    })

    const parsed = await parsePdf(res.content)

    parsed.pages[0].text.should.be.eql('foo')
    logs.should.matchAny(/Delegating recipe/)
  })

  it('should also render headers in pdf', async () => {
    const res = await reporter.render({
      template: {
        content: 'foo',
        recipe: 'chrome-pdf',
        engine: 'none',
        chrome: { headerTemplate: 'header' }
      }
    })

    res.content.toString().should.containEql('PDF')

    logs.should.matchAny(/Processing render callback from worker/)
  })

  it('should render both header and footer in worker', async () => {
    const res = await reporter.render({
      template: {
        content: 'foo',
        recipe: 'chrome-pdf',
        engine: 'none',
        chrome: { headerTemplate: 'header', footerTemplate: 'footer' }
      }
    })

    res.content.toString().should.containEql('PDF')

    logs
      .filter(m => /Processing render callback from worker/.test(m))
      .should.have.length(2)
  })

  it('should evaluate handlebars in worker', async () => {
    const res = await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'html',
        engine: 'handlebars'
      },
      data: { foo: 'hello' }
    })

    res.content.toString().should.be.eql('hello')

    logs.should.matchAny(/Delegating script/)
  })

  it('should keep properties assigned to req objects during script execution', async () => {
    let sameInReq = false
    let sameInRes = false

    reporter.afterRenderListeners.add('app', async (req, res) => {
      sameInReq = req.data.someProp === true
      sameInRes = res.meta.someProp === true
    })

    await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'html',
        engine: 'handlebars',
        scripts: [{
          content: `
            function beforeRender (req, res) {
              req.data.someProp = true
            }

            function afterRender (req, res) {
              res.meta.someProp = true
            }
          `
        }]
      },
      data: { foo: 'hello' }
    })

    sameInReq.should.be.True()
    sameInRes.should.be.True()
  })
})

describe('docker worker-container rotation', () => {
  let reporter
  let logs = []

  beforeEach(async () => {
    logs = []

    reporter = createReporterInstance()

    await reporter.init()

    addLogsRewriter(reporter, logs)
  })

  afterEach(async () => {
    if (reporter) {
      await reporter.close()
    }
  })

  it('should process request when tenant does not have a worker', async () => {
    const res = await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'chrome-pdf',
        engine: 'handlebars'
      },
      data: {
        foo: 'foo'
      }
    })

    const parsed = await parsePdf(res.content)

    parsed.pages[0].text.should.be.eql('foo')

    logs.should.matchAny(new RegExp(`No docker container previously assigned`))
    logs.should.matchAny(new RegExp(`No need to restart unassigned docker container`))
    logs.should.matchAny(new RegExp(`Delegating script to container in local worker`))
    logs.should.matchAny(new RegExp(`Delegating recipe chrome-pdf to container in local worker`))
  })

  it('should find LRU worker', async () => {
    const lastContainerIndex = reporter.dockerManager.containersManager.registry.length - 1
    const container = reporter.dockerManager.containersManager.registry[lastContainerIndex]

    container.lastUsed = new Date(Date.now() - 60000)

    const res = await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'chrome-pdf',
        engine: 'handlebars'
      },
      data: {
        foo: 'foo'
      }
    })

    const parsed = await parsePdf(res.content)

    parsed.pages[0].text.should.be.eql('foo')

    logs.should.matchAny(new RegExp(`No docker container previously assigned, searching by LRU`))
    logs.should.matchAny(new RegExp(`LRU container is ${container.id}`))
  })

  it('should reuse same worker in multiple tasks for same request', async () => {
    const container = reporter.dockerManager.containersManager.registry[0]
    const choosedContainers = []

    const originalFindContainer = reporter.dockerManager.containersManager.findContainer

    reporter.dockerManager.containersManager.findContainer = async function (...args) {
      const elected = await originalFindContainer.apply(reporter.dockerManager.containersManager, args)
      choosedContainers.push(elected.id)
      return elected
    }

    await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'chrome-pdf',
        engine: 'handlebars',
        chrome: { headerTemplate: 'header' }
      },
      data: {
        foo: 'foo'
      }
    })

    choosedContainers.should.matchEach(container.id)
  })

  it('should set tenant to worker ip', async () => {
    const res = await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'chrome-pdf',
        engine: 'handlebars'
      },
      data: {
        foo: 'foo'
      }
    })

    const parsed = await parsePdf(res.content)

    parsed.pages[0].text.should.be.eql('foo')

    const tenantWorker = await reporter.documentStore.collection('tenantWorkers').findOne({
      tenant: testTenant,
      stack
    })

    should(tenantWorker).be.ok()
    tenantWorker.ip.should.be.eql(ip)
  })

  it('should unset old tenant worker ip', async () => {
    reporter.beforeRenderListeners.add('app', async (req, res) => {
      req.context.tenant = req.context.reportCounter % 2 !== 0 ? testTenant : 'secondTenant'
    })

    const res = await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'chrome-pdf',
        engine: 'handlebars'
      },
      data: {
        foo: 'foo'
      }
    })

    let parsed = await parsePdf(res.content)

    parsed.pages[0].text.should.be.eql('foo')

    let tenantWorker = await reporter.documentStore.collection('tenantWorkers').findOne({
      tenant: testTenant,
      stack
    })

    should(tenantWorker).be.ok()
    tenantWorker.ip.should.be.eql(ip)

    const res2 = await reporter.render({
      template: {
        content: '{{bar}}',
        recipe: 'chrome-pdf',
        engine: 'handlebars'
      },
      data: {
        bar: 'bar'
      }
    })

    parsed = await parsePdf(res2.content)

    parsed.pages[0].text.should.be.eql('bar')

    await new Promise((resolve) => {
      setTimeout(resolve, 1000)
    })

    tenantWorker = await reporter.documentStore.collection('tenantWorkers').findOne({
      tenant: testTenant,
      stack
    })

    should(tenantWorker).be.not.ok()
  })

  it('should queue request when all workers are busy', async () => {
    reporter.beforeRenderListeners.add('app', async (req, res) => {
      const result = req.context.reportCounter % 2

      if (result === 1) {
        req.context.tenant = testTenant
      } else {
        req.context.tenant = 'secondTenant'
      }
    })

    await Promise.all([
      await reporter.render({
        template: {
          content: '{{foo}}',
          recipe: 'chrome-pdf',
          engine: 'handlebars'
        },
        data: {
          foo: 'foo'
        }
      }),
      await reporter.render({
        template: {
          content: '{{foo}}',
          recipe: 'chrome-pdf',
          engine: 'handlebars'
        },
        data: {
          foo: 'foo'
        }
      }),
      await reporter.render({
        template: {
          content: '{{foo}}',
          recipe: 'chrome-pdf',
          engine: 'handlebars'
        },
        data: {
          foo: 'foo'
        }
      })
    ])

    logs.should.matchAny(new RegExp(`All docker containers are busy, queuing work`))
  })

  it('should restart worker before switching from other tenant', async () => {
    const container = reporter.dockerManager.containersManager.registry[0]

    reporter.dockerManager.containersManager.registry.forEach((c, index) => {
      c.tenant = `usedTenant${index + 1}`
    })

    const res = await reporter.render({
      template: {
        content: '{{foo}}',
        recipe: 'chrome-pdf',
        engine: 'handlebars'
      },
      data: {
        foo: 'foo'
      }
    })

    const parsed = await parsePdf(res.content)

    parsed.pages[0].text.should.be.eql('foo')

    logs.should.matchAny(new RegExp(`Restarting and unregistering previous assigned docker container ${container.id}`))
  })

  it('should restart last used worker after process', async () => {
    const container = reporter.dockerManager.containersManager.registry[0]

    reporter.beforeRenderListeners.add('app', async (req, res) => {
      req.context.tenant = req.context.reportCounter % 2 !== 0 ? testTenant : 'secondTenant'
    })

    await Promise.all([
      reporter.render({
        template: {
          content: '{{foo}}',
          recipe: 'chrome-pdf',
          engine: 'handlebars'
        },
        data: {
          foo: 'foo'
        }
      }),
      reporter.render({
        template: {
          content: '{{bar}}',
          recipe: 'chrome-pdf',
          engine: 'handlebars'
        },
        data: {
          bar: 'bar'
        }
      })
    ])

    await new Promise((resolve) => {
      setTimeout(resolve, 1000)
    })

    logs.should.matchAny(new RegExp(`Warming up docker container ${container.id}`))
    logs.should.matchAny(new RegExp(`Restarting docker container ${container.id}`))
  })

  it('should not be able to communicate with other container using host ip', async function () {
    if (!IS_LINUX) {
      console.log('not running this test because os is not linux')
      await reporter.close()
      return
    }

    if (hostIp == null) {
      throw new Error('test require to define env var process.env.hostIp to local host ip')
    }

    const container = reporter.dockerManager.containersManager.registry[1]

    try {
      await reporter.render({
        template: {
          content: 'Request {{bar}}',
          recipe: 'html',
          engine: 'handlebars',
          scripts: [{
            content: `
              const ip = "${hostIp}"
              const targetPort = ${container.port}
              const http = require('http')

              function beforeRender(req, res, done) {
                const target = 'http://' + ip + ':' + targetPort
                console.log('doing request to other worker ' + target + ' from script')

                http.get(target, (res) => {
                  const { statusCode } = res

                  if (statusCode !== 200) {
                    console.log('request to ' + target + ' ended with erro, status ' + statusCode)
                    done()
                  } else {
                    console.log('request to ' + target + ' was good')

                    res.setEncoding('utf8');
                    let rawData = '';

                    res.on('data', (chunk) => { rawData += chunk; })

                    res.on('end', () => {
                      console.log('request to ' + target + ' body response: ' + rawData)
                      done()
                    })
                  }
                }).on('error', (err) => {
                  done(err)
                })
              }
            `
          }]
        },
        data: {
          bar: 'bar'
        }
      })

      throw new Error('it was supposed to fail and not be able to communicate with other container, please check that you have setup iptables rules first')
    } catch (e) {
      e.message.should.match(/connect ECONNREFUSED/)
    }
  })
})

remoteWorkerTests('docker with remote worker', '127.0.0.1')

remoteWorkerTests('docker with remote worker (auth enabled)', '127.0.0.1', true)

function remoteWorkerTests (title, remoteIp, authEnabled = false) {
  let reporter
  let remoteReporter
  let logs = []

  describe(title, async () => {
    const sharedDataDirectory = path.join(__dirname, 'temp')

    beforeEach(async () => {
      logs = []

      try {
        utils.removeDir(sharedDataDirectory)
      } catch (e) {}

      reporter = createReporterInstance({
        store: {
          provider: 'fs'
        },
        extensions: {
          'fs-store': {
            dataDirectory: sharedDataDirectory,
            syncModifications: false
          }
        }
      }, authEnabled)

      await reporter.init()

      addLogsRewriter(reporter, logs)

      process.env.remoteIp = remoteIp

      remoteReporter = createReporterInstance({
        httpPort: 5489,
        store: {
          provider: 'fs'
        },
        extensions: {
          'fs-store': {
            dataDirectory: sharedDataDirectory,
            syncModifications: false
          },
          'worker-docker-manager': {
            ipEnvVarName: 'remoteIp',
            containerNamePrefix: 'remote_jsreport_worker',
            containerBasePublishPort: 4001
          }
        }
      }, authEnabled)

      await remoteReporter.init()

      await reporter.documentStore.collection('servers').update({
        ip: remoteIp,
        stack
      }, {
        $set: {
          ip: remoteIp,
          ping: new Date(),
          stack
        }
      }, { upsert: true })

      await reporter.dockerManager.serversChecker.refreshServersCache()
      await remoteReporter.dockerManager.serversChecker.refreshServersCache()
    })

    afterEach(async () => {
      delete process.env.remoteIp

      if (reporter) {
        await reporter.close()
      }

      if (remoteReporter) {
        await remoteReporter.close()
      }
    })

    it('should proxy request when tenant has active worker', async () => {
      await reporter.documentStore.collection('tenantWorkers').insert({
        ip: remoteIp,
        port: 5489,
        stack,
        tenant: testTenant,
        updateAt: new Date()
      })

      const res = await reporter.render({
        template: {
          content: '{{foo}}',
          recipe: 'chrome-pdf',
          engine: 'handlebars'
        },
        data: {
          foo: 'foo'
        }
      })

      const parsed = await parsePdf(res.content)

      parsed.pages[0].text.should.be.eql('foo')

      logs.should.matchAny(new RegExp(`Delegating script to external worker at http://${remoteIp}:5489`))
      logs.should.matchAny(new RegExp(`Delegating recipe chrome-pdf to external worker at http://${remoteIp}:5489`))
    })

    it('should process request when tenant has worker assigned but it is not active', async () => {
      await reporter.documentStore.collection('tenantWorkers').insert({
        ip: remoteIp,
        port: 5489,
        stack,
        tenant: testTenant,
        updateAt: new Date()
      })

      reporter.dockerManager.serversChecker.stopPingInterval()
      remoteReporter.dockerManager.serversChecker.stopPingInterval()

      await reporter.documentStore.collection('servers').update({
        ip: remoteIp,
        stack
      }, {
        $set: {
          // makes the server to fail the status check
          ping: new Date(Date.now() - 300000)
        }
      })

      await reporter.dockerManager.serversChecker.refreshServersCache()

      const res = await reporter.render({
        template: {
          content: '{{foo}}',
          recipe: 'chrome-pdf',
          engine: 'handlebars'
        },
        data: {
          foo: 'foo'
        }
      })

      const parsed = await parsePdf(res.content)

      parsed.pages[0].text.should.be.eql('foo')

      logs.should.matchAny(new RegExp(`Remote worker ${remoteIp} is not healthy, continuing request in local`))
      logs.should.matchAny(new RegExp(`Delegating script to container in local worker`))
      logs.should.matchAny(new RegExp(`Delegating recipe chrome-pdf to container in local worker`))
    })
  })
}
