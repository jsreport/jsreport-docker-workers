const util = require('util')
const path = require('path')
const fs = require('fs')
const readFileAsync = util.promisify(fs.readFile)
const writeFileAsync = util.promisify(fs.writeFile)

module.exports = (reporter) => {
  reporter.dockerManager.addContainerDelegateRequestFilterListener('generalFilter', async ({ type, reqData, meta }) => {
    const uuid = reqData.uuid
    const isRemote = meta.remote

    if (isRemote) {
      return
    }

    const filesToSave = []
    let data

    if (reqData.data) {
      data = Object.assign({}, reqData.data)
    } else {
      data = {}
    }

    if (type === 'scriptManager') {
      if (data.req && data.req.template && data.req.template.content) {
        const tmpFilename = `${type}-${uuid}-req-template.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          content: data.req.template.content
        })

        data.req = Object.assign({}, data.req)
        data.req.template = Object.assign({}, data.req.template)
        data.req.template.content = tmpFilename
      }

      if (data.inputs.template && data.inputs.template.content) {
        const tmpFilename = `${type}-${uuid}-inputs-template.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          content: data.inputs.template.content
        })

        data.inputs = Object.assign({}, data.inputs)
        data.inputs.template = Object.assign({}, data.inputs.template)
        data.inputs.template.content = tmpFilename
      }
    } else if (type === 'recipe') {
      if (data.req && data.req.template && data.req.template.content) {
        const tmpFilename = `${type}-${uuid}-req-template.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          content: data.req.template.content
        })

        data.req = Object.assign({}, data.req)
        data.req.template = Object.assign({}, data.req.template)
        data.req.template.content = tmpFilename
      }

      if (data.res && data.res.content) {
        const tmpFilename = `${type}-${uuid}-res-content.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          content: data.res.content
        })

        data.res = Object.assign({}, data.res)
        data.res.content = tmpFilename
      }
    }

    if (filesToSave.length > 0) {
      await Promise.all(filesToSave.map((info) => writeFileAsync(info.path, info.content)))
      reqData.data = data
      return reqData
    }
  })

  reporter.dockerManager.addContainerDelegateResponseFilterListener('generalFilter', async ({ type, resData, meta }) => {
    const isRemote = meta.remote

    if (isRemote) {
      return
    }

    let data

    if (resData.data) {
      data = Object.assign({}, resData.data)
    } else {
      data = {}
    }

    if (type === 'scriptManager') {
      if (data.content) {
        data.content = (await readFileAsync(path.join(meta.requestAutoCleanupTempDirectory, data.content))).toString()
      }
    } else if (type === 'recipe') {
      if (data.req && data.req.template && data.req.template.content) {
        data.req.template.content = (await readFileAsync(path.join(meta.requestAutoCleanupTempDirectory, data.req.template.content))).toString()
      }

      if (data.res && data.res.content) {
        data.res.content = await readFileAsync(path.join(meta.requestAutoCleanupTempDirectory, data.res.content))
      }

      resData.data = data
      return resData
    }
  })
}
