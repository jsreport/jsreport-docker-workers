
const jsreport = require('jsreport-core')
const IS_LINUX = process.platform === 'linux'
const hostIp = process.env.ip

if (hostIp == null) {
  throw new Error('tests require to define env var process.env.ip to local host ip')
}

require('should')

describe('docker', () => {
  let reporter

  beforeEach(() => {
    reporter = jsreport({ allowLocalFilesAccess: true })
      .use({
        name: 'app',
        main: (reporter, definition) => {
          let requests = 0
          const users = ['even', 'odd']

          reporter.beforeRenderListeners.add('app', async (req, res) => {
            requests++
            req.context.tenant = users[requests % 2]
          })
        }
      })
      .use(require('jsreport-handlebars')())
      .use(require('jsreport-scripts')())
      .use(require('jsreport-worker-delegate')())
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

  describe('networking', () => {
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
})
