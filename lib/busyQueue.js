
class BusyQueue {
  constructor (reporter, { run, waitingTimeout } = {}) {
    this.run = run
    this.busyQueue = []
    this.reporter = reporter
    this.waitingTimeout = waitingTimeout
  }

  push (item, resolve, reject) {
    this.busyQueue.push({
      submittedOn: new Date().getTime(),
      item: item,
      resolve: resolve,
      reject: reject
    })
  }

  get length () {
    return this.busyQueue.length
  }

  flush () {
    const item = this.busyQueue.shift()

    if (item) {
      if (item.submittedOn < (new Date().getTime() - this.waitingTimeout)) {
        this.reporter.logger.debug('Timeout when waiting for worker availability (busy queue)')

        item.reject(new Error('Timeout when waiting for worker availability (busy queue)'))

        return this.flush()
      }

      this.reporter.logger.debug(`Busy queue length: ${this.busyQueue.length}`)

      this.run(item.item).then((res) => item.resolve(res)).catch(item.reject)
    }
  }
}

module.exports = (reporter, options) => new BusyQueue(reporter, options)
