
const should = require('should')
const parsePdf = require('parse-pdf')
const jsreport = require('jsreport-core')

const IS_LINUX = process.platform === 'linux'
const hostIp = process.env.ip

if (hostIp == null) {
  throw new Error('tests require to define env var process.env.ip to local host ip')
}

describe('docker', () => {
  let reporter

  beforeEach(() => {
    reporter = jsreport({ allowLocalFilesAccess: true })
      .use({
        name: 'app',
        directory: __dirname,
        main: (reporter, definition) => {
          reporter.beforeRenderListeners.add('app', async (req, res) => {
            req.context.tenant = 'demoTenant'
          })
        }
      })
      .use(require('jsreport-express')())
      .use(require('jsreport-chrome-pdf')())
      .use(require('jsreport-handlebars')())
      .use(require('jsreport-scripts')())
      .use(require('../')({
        discriminatorPath: 'context.tenant'
      }))

    return reporter.init()
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

    const delegatedLog = res.meta.logs.map(l => l.message).find(m => m.includes('Delegating recipe'))

    should(delegatedLog).be.ok()
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
    res.meta.logs.map(l => l.message).should.containEql('Processing render callback from worker.')
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
    res.meta.logs
      .filter(l => l.message.includes('Processing render callback from worker.'))
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

    const delegatedLog = res.meta.logs.map(l => l.message).find(m => m.includes('Delegating script'))

    should(delegatedLog).be.ok()
  })
})

describe('docker networking', () => {
  let reporter

  beforeEach(() => {
    reporter = jsreport({ allowLocalFilesAccess: true })
      .use({
        name: 'app',
        directory: __dirname,
        main: (reporter, definition) => {
          let requests = 0
          const users = ['even', 'odd']

          reporter.beforeRenderListeners.add('app', async (req, res) => {
            requests++
            req.context.tenant = users[requests % 2]
          })
        }
      })
      .use(require('jsreport-express')())
      .use(require('jsreport-chrome-pdf')())
      .use(require('jsreport-handlebars')())
      .use(require('jsreport-scripts')())
      .use(require('../')({
        discriminatorPath: 'context.tenant'
      }))

    return reporter.init()
  })

  afterEach(async () => {
    if (reporter) {
      await reporter.close()
    }
  })

  // TODO: assert only on linux and do a propert assert (it should error)
  it('should not be able to communicate with other container using host ip', async function () {
    if (!IS_LINUX) {
      await reporter.close()
      return this.skip()
    }

    await reporter.render({
      template: {
        content: 'Request {{foo}}',
        recipe: 'html',
        engine: 'handlebars'
      },
      data: {
        foo: 'foo'
      }
    })

    await reporter.render({
      template: {
        content: 'Request {{bar}}',
        recipe: 'html',
        engine: 'handlebars',
        scripts: [{
          content: `
            const ip = "${hostIp}"
            const http = require('http')

            function beforeRender(req, res, done) {
              const target = 'http://' + ip + ':2001'
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
  })
})
