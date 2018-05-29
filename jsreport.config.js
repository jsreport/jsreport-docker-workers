
module.exports = {
  'name': 'worker-docker-manager',
  'main': 'lib/dockerManager.js',
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
          containerImage: { type: 'string', default: 'worker' },
          containerNamePrefix: { type: 'string', default: 'jsreport_worker' },
          containerExposedPort: { type: 'number', default: 2000 },
          containerBasePublishPort: { type: 'number', default: 2001 },
          containerStartTimeout: { type: 'number', default: 10000 },
          containerRestartPolicy: { type: 'boolean', default: true },
          containerRestartTimeout: { type: 'number', default: 5000 },
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
