const util = require('util')
const path = require('path')
const fs = require('fs')
const set = require('lodash.set')
const readFileAsync = util.promisify(fs.readFile)
const writeFileAsync = util.promisify(fs.writeFile)

module.exports = (reporter) => {
  reporter.dockerManager.addContainerDelegateRequestFilterListener('generalFilter', async ({ type, reqData, meta }) => {
    const isRemote = meta.remote

    if (isRemote) {
      return
    }

    const uuid = reqData.uuid

    const filesToSave = []
    let data

    if (reqData.data) {
      data = Object.assign({}, reqData.data)
    } else {
      data = {}
    }

    if (type === 'scriptManager') {
      if (data.req && data.req.template && data.req.template.content) {
        const tmpFilename = `${type}-${uuid}-request-req-template.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          content: data.req.template.content
        })

        data.req = Object.assign({}, data.req)
        data.req.template = Object.assign({}, data.req.template)

        data.req.template.content = {
          type: typeof data.req.template.content === 'string' ? 'string' : 'buffer',
          file: tmpFilename
        }
      }

      if (data.inputs) {
        data.inputs = Object.assign({}, data.inputs)

        if (data.inputs.template && data.inputs.template.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-template.txt`

          filesToSave.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
            content: data.inputs.template.content
          })

          data.inputs.template = Object.assign({}, data.inputs.template)

          data.inputs.template.content = {
            type: typeof data.inputs.template.content === 'string' ? 'string' : 'buffer',
            file: tmpFilename
          }
        }

        if (data.inputs.request && data.inputs.request.template && data.inputs.request.template.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-req-template.txt`

          filesToSave.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
            content: data.inputs.request.template.content
          })

          data.inputs.request = Object.assign({}, data.inputs.request)
          data.inputs.request.template = Object.assign({}, data.inputs.request.template)

          data.inputs.request.template.content = {
            type: typeof data.inputs.request.template.content === 'string' ? 'string' : 'buffer',
            file: tmpFilename
          }
        }

        if (data.inputs.response && data.inputs.response.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-res-content.txt`

          filesToSave.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
            content: data.inputs.response.content
          })

          data.inputs.response = Object.assign({}, data.inputs.response)

          data.inputs.response.content = {
            type: typeof data.inputs.response.content === 'string' ? 'string' : 'buffer',
            file: tmpFilename
          }
        }

        if (data.inputs.pdfContent) {
          const tmpFilename = `${type}-${uuid}-request-inputs-pdfcontent.txt`

          filesToSave.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
            content: data.inputs.pdfContent
          })

          data.inputs.pdfContent = {
            type: typeof data.inputs.pdfContent === 'string' ? 'string' : 'buffer',
            file: tmpFilename
          }
        }
      }
    } else if (type === 'recipe') {
      if (data.req && data.req.template && data.req.template.content) {
        const tmpFilename = `${type}-${uuid}-request-req-template.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          content: data.req.template.content
        })

        data.req = Object.assign({}, data.req)
        data.req.template = Object.assign({}, data.req.template)

        data.req.template.content = {
          type: typeof data.req.template.content === 'string' ? 'string' : 'buffer',
          file: tmpFilename
        }
      }

      if (data.res && data.res.content) {
        const tmpFilename = `${type}-${uuid}-request-res-content.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          content: data.res.content
        })

        data.res = Object.assign({}, data.res)

        data.res.content = {
          type: typeof data.res.content === 'string' ? 'string' : 'buffer',
          file: tmpFilename
        }
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

    const filesToRead = []
    const data = resData

    if (type === 'scriptManager') {
      if (data.content) {
        filesToRead.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, data.content.file),
          type: data.content.type,
          propPath: 'content'
        })
      }

      if (data.request && data.request.template && data.request.template.content) {
        filesToRead.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, data.request.template.content.file),
          type: data.request.template.content.type,
          propPath: 'request.template.content'
        })
      }

      if (data.response && data.response.content) {
        filesToRead.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, data.response.content.file),
          type: data.response.content.type,
          propPath: 'response.content'
        })
      }

      if (data.pdfContent) {
        filesToRead.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, data.pdfContent.file),
          type: data.pdfContent.type,
          propPath: 'pdfContent'
        })
      }
    } else if (type === 'recipe') {
      if (data.req && data.req.template && data.req.template.content) {
        filesToRead.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, data.req.template.content.file),
          type: data.req.template.content.type,
          propPath: 'req.template.content'
        })
      }

      if (data.res && data.res.content) {
        filesToRead.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, data.res.content.file),
          type: data.res.content.type,
          propPath: 'res.content'
        })
      }
    }

    if (filesToRead.length > 0) {
      await Promise.all(filesToRead.map(async (info) => {
        const content = await readContentFile(info.path, info.type)
        set(data, info.propPath, content)
      }))

      return data
    }
  })
}

async function readContentFile (pathToContent, type) {
  let content = await readFileAsync(pathToContent)

  if (type !== 'string' && type !== 'buffer') {
    throw new Error(`Invalid content type "${type}" found when trying to read content from temp file`)
  }

  if (type === 'string') {
    content = content.toString()
  }

  return content
}
