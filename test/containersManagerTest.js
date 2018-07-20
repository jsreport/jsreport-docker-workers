const createContainersManager = require('../lib/containersManager')
const reporter = require('jsreport-core')()

describe('containers manager', () => {
  let containersManager

  beforeEach(async () => {
    containersManager = createContainersManager({
      predefinedContainersPool: {
        containers: [{id: 'a'}, {id: 'b'}],
        start: () => {},
        remove: () => {}
      },
      logger: reporter.logger
    })

    return containersManager.start()
  })

  afterEach(() => containersManager.close())

  it('allocate should get unsused container and set lastUsed, tenant and inc numberOfRequests', async () => {
    const container = await containersManager.allocate({
      tenant: 'a'
    })

    container.lastUsed.should.be.ok()
    container.numberOfRequests.should.be.eql(1)
    container.tenant = 'a'
  })

  it('allocate should reuese assigned container and increase number of requests', async () => {
    containersManager.containers[0].tenant = 'a'
    containersManager.containers[0].numberOfRequests = 1
    const container = await containersManager.allocate({
      tenant: 'a'
    })

    container.numberOfRequests.should.be.eql(2)
  })

  it('allocate should find container LRU and restart', async () => {
    containersManager.containers[0].lastUsed = new Date()
    containersManager.containers[0].tenant = 'a'
    containersManager.containers[1].lastUsed = new Date(new Date().getTime() - 1000)
    containersManager.containers[1].tenant = 'b'

    let recycled = false
    containersManager.onRecycle(() => (recycled = true))

    const container = await containersManager.allocate({
      tenant: 'c'
    })

    container.should.be.eql(containersManager.containers[1])
    container.numberOfRestarts.should.be.eql(1)
    recycled.should.be.true()
  })

  it('allocate should queue if all containers are busy', (done) => {
    containersManager.containers[0].tenant = 'a'
    containersManager.containers[0].numberOfRequests = 1
    containersManager.containers[1].tenant = 'b'
    containersManager.containers[1].numberOfRequests = 1
    containersManager.busyQueue.push = () => done()

    containersManager.allocate({
      tenant: 'c'
    })
  })

  it('recycle should restart container', async () => {
    const container = containersManager.containers[0]
    container.numberOfRequests = 1
    await containersManager.recycle({ container })
    container.numberOfRestarts.should.be.eql(1)
    container.numberOfRequests.should.be.eql(0)
  })

  it('release should decrease number of requests', async () => {
    const container = containersManager.containers[0]
    container.numberOfRequests = 1
    await containersManager.release(container)
    container.numberOfRestarts.should.be.eql(0)
    container.numberOfRequests.should.be.eql(0)
  })

  it('release should flush queue', (done) => {
    containersManager.busyQueue.flush = () => done()
    const container = containersManager.containers[0]
    container.numberOfRequests = 1
    containersManager.release(container)
  })

  it('release should warmup last used container', (done) => {
    containersManager.containers[1].tenant = 'x'
    containersManager.containers[1].restart = done
    const container = containersManager.containers[0]
    container.numberOfRequests = 1
    containersManager.release(container)
  })
})