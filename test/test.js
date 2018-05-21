const jsreport = require('jsreport-core')
const express = require('express')

const ip = process.env.ip

if (ip == null) {
  throw new Error('tests require to define env var process.env.ip to local ip')
}

require('should')

describe('docker', () => {
  let reporter
  let customServer

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
      .use(require('../')({
        discriminatorPath: 'context.tenant'
      }))
      .use(require('jsreport-worker-delegate')())
      .use(require('jsreport-handlebars')())
      .use(require('jsreport-scripts')())

    return new Promise((resolve, reject) => {
      const app = express()

      app.get('/', (req, res) => {
        res.status(200).end('ok response')
      })

      customServer = app.listen(2000, () => {
        console.log('custom server started at port 2000')
        resolve()
      })

      customServer.on('error', (err) => {
        reject(err)
      })
    }).then(() => reporter.init())
  })

  afterEach(() => {
    customServer.close()
    return reporter.close()
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

  it('networking', async () => {
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
            const ip = "${ip}"
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
