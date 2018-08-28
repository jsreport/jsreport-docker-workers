
module.exports = {
  'name': 'worker-docker-manager',
  'main': 'lib/main.js',
  'dependencies': ['express'],
  'optionsSchema': {
    extensions: {
      'worker-docker-manager': {
        type: 'object',
        properties: {
          ipEnvVarName: { type: 'string', default: 'ip' },
          stackEnvVarName: { type: 'string', default: 'stack' },
          discriminatorPath: { type: 'string' },
          pingServersInterval: { type: 'number', default: 5000 },
          pingHealthyInterval: { type: 'number', default: 20000 },
          containerImage: { type: 'string', default: 'jsreport/jsreport-worker' },
          containerNamePrefix: { type: 'string', default: 'jsreport_worker' },
          containerExposedPort: { type: 'number', default: 2000 },
          containerBasePublishPort: { type: 'number', default: 2001 },
          containerCustomEnv: {
            anyOf: [{
              type: 'string',
              '$jsreport-constantOrArray': []
            }, {
              type: 'array',
              items: { type: 'string' }
            }]
          },
          containerStartTimeout: { type: 'number', default: 10000 },
          containerRestartPolicy: { type: 'boolean', default: true },
          containerRestartTimeout: { type: 'number', default: 5000 },
          containerDelegateTimeout: { type: 'number', default: 50000 },
          containerDebuggingSession: { type: 'boolean', default: false },
          containerMemorySwap: { type: 'string', default: '512m' },
          containerMemory: { type: 'string', default: '420m' },
          containerCPUs: { type: 'string', default: '0.5' },
          containerLogDriver: { type: 'string', default: 'json-file' },
          containerLogOpt: { type: 'object' },
          subnet: { type: 'string', default: '172.30.0.0/24' },
          network: { type: 'string', default: 'nw_jsreport_workers_docker_manager' },
          busyQueueWaitingTimeout: { type: 'number', default: 10000 },
          maxContainers: { type: 'number', minimum: 1, default: 4 }
        },
        required: ['discriminatorPath']
      }
    }
  }
}
