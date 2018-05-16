const jsreport = require('jsreport-core')
require('should')

describe('docker', () => {
  let reporter

  beforeEach(() => {
    reporter = jsreport()
      .use(require('../')())
      .use(require('jsreport-worker-delegate')())
      .use(require('jsreport-handlebars')())

    return reporter.init()
  })

  afterEach(() => {
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
})
