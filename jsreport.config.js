
module.exports = {
  'name': 'worker-docker-manager',
  'main': 'lib/main.js',
  'dependencies': ['express'],
  'optionsSchema': {
    ip: { type: 'string' },
    stack: { type: 'string', default: 'default' },
    extensions: {
      'worker-docker-manager': {
        type: 'object',
        properties: {
          discriminatorPath: { type: 'string', default: 'context.reportCounter' },
          pingServersInterval: { type: 'number', default: 5000 },
          pingHealthyInterval: { type: 'number', default: 20000 },
          container: {
            type: 'object',
            default: {
              image: 'jsreport/jsreport-worker',
              namePrefix: 'jsreport_worker',
              exposedPort: 2000,
              basePublishPort: 2001,
              startTimeout: 10000,
              restartPolicy: true,
              delegateTimeout: 50000,
              debuggingSession: false,
              memorySwap: '512m',
              memory: '420m',
              cpus: '0.5',
              logDriver: 'json-file',
              tempVolumeTarget: '/tmp'
            },
            properties: {
              image: { type: 'string', default: 'jsreport/jsreport-worker' },
              namePrefix: { type: 'string', default: 'jsreport_worker' },
              exposedPort: { type: 'number', default: 2000 },
              basePublishPort: { type: 'number', default: 2001 },
              customEnv: {
                anyOf: [{
                  type: 'string',
                  '$jsreport-constantOrArray': []
                }, {
                  type: 'array',
                  items: { type: 'string' }
                }]
              },
              startTimeout: { type: 'number', default: 10000 },
              restartPolicy: { type: 'boolean', default: true },
              restartTimeout: { type: 'number', default: 5000 },
              delegateTimeout: { type: 'number', default: 50000 },
              debuggingSession: { type: 'boolean', default: false },
              memorySwap: { type: 'string', default: '512m' },
              memory: { type: 'string', default: '420m' },
              cpus: { type: 'string', default: '0.5' },
              logDriver: { type: 'string', default: 'json-file' },
              logOpt: { type: 'object' },
              tempVolumeSourcePrefix: { type: 'string' },
              tempVolumeTarget: { type: 'string', default: '/tmp' }
            }
          },
          subnet: { type: 'string', default: '172.30.0.0/24' },
          network: { type: 'string', default: 'nw_jsreport_workers_docker_manager' },
          busyQueueWaitingTimeout: { type: 'number', default: 10000 },
          numberOfWorkers: { type: 'number', minimum: 1, default: 4 }
        }
      }
    }
  }
}
