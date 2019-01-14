const util = require('util')
const path = require('path')
const fs = require('fs')
const get = require('lodash.get')
const set = require('lodash.set')
const axios = require('axios')
const readFileAsync = util.promisify(fs.readFile)
const writeFileAsync = util.promisify(fs.writeFile)

module.exports = (reporter) => {
  reporter.dockerManager.addContainerDelegateRequestFilterListener('generalFilter', async ({ type, originalReq, reqData, meta }) => {
    const isRemote = meta.remote
    const fromRemotePrimary = meta.fromRemotePrimary
    const tempDirectory = meta.requestAutoCleanupTempDirectory
    const uuid = meta.uuid

    const readFileFromRemote = createRemoteFileReader({
      authentication: reporter.authentication ? {
        username: reporter.options.extensions.authentication.admin.username,
        password: reporter.options.extensions.authentication.admin.password
      } : undefined,
      timeout: meta.delegateTimeout
    })

    let filesToSave = []
    let data

    if (reqData.data) {
      data = Object.assign({}, reqData.data)
    } else {
      data = {}
    }

    if (type === 'scriptManager') {
      if (data.content) {
        const tmpFilename = `${type}-${uuid}-request-content.txt`

        filesToSave.push({
          path: path.join(tempDirectory, tmpFilename),
          file: tmpFilename,
          propPath: 'content',
          content: data.content
        })
      }

      if (data.req && data.req.template && data.req.template.content) {
        const tmpFilename = `${type}-${uuid}-request-req-template.txt`

        filesToSave.push({
          path: path.join(tempDirectory, tmpFilename),
          file: tmpFilename,
          propPath: 'req.template.content',
          content: data.req.template.content
        })
      }

      if (data.inputs) {
        if (data.inputs.template && data.inputs.template.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-template.txt`

          filesToSave.push({
            path: path.join(tempDirectory, tmpFilename),
            file: tmpFilename,
            propPath: 'inputs.template.content',
            content: data.inputs.template.content
          })
        }

        if (data.inputs.request && data.inputs.request.template && data.inputs.request.template.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-req-template.txt`

          filesToSave.push({
            path: path.join(tempDirectory, tmpFilename),
            file: tmpFilename,
            propPath: 'inputs.request.template.content',
            content: data.inputs.request.template.content
          })
        }

        if (data.inputs.response && data.inputs.response.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-res-content.txt`

          filesToSave.push({
            path: path.join(tempDirectory, tmpFilename),
            file: tmpFilename,
            propPath: 'inputs.response.content',
            content: data.inputs.response.content
          })
        }

        if (data.inputs.pdfContent) {
          const tmpFilename = `${type}-${uuid}-request-inputs-pdfcontent.txt`

          filesToSave.push({
            path: path.join(tempDirectory, tmpFilename),
            file: tmpFilename,
            propPath: 'inputs.pdfContent',
            content: data.inputs.pdfContent
          })
        }
      }
    } else if (type === 'recipe') {
      if (data.content) {
        const tmpFilename = `${type}-${uuid}-request-content.txt`

        filesToSave.push({
          path: path.join(tempDirectory, tmpFilename),
          file: tmpFilename,
          propPath: 'content',
          content: data.content
        })
      }

      if (data.req && data.req.template && data.req.template.content) {
        const tmpFilename = `${type}-${uuid}-request-req-template.txt`

        filesToSave.push({
          path: path.join(tempDirectory, tmpFilename),
          file: tmpFilename,
          propPath: 'req.template.content',
          content: data.req.template.content
        })
      }

      if (data.res && data.res.content) {
        const tmpFilename = `${type}-${uuid}-request-res-content.txt`

        filesToSave.push({
          path: path.join(tempDirectory, tmpFilename),
          file: tmpFilename,
          propPath: 'res.content',
          content: data.res.content
        })
      }
    }

    if (filesToSave.length > 0) {
      if (fromRemotePrimary && meta.remoteTempFiles) {
        await Promise.all(filesToSave.map(async (item, idx) => {
          const remoteFileContent = await readFileFromRemote(meta.remoteTempFiles.source, {
            file: path.join(meta.remoteTempFiles.tempDirectory, item.content.file),
            type: item.content.type
          })

          filesToSave[idx].content = remoteFileContent

          if (item.propPath.startsWith('req.')) {
            // restoring originalReq to normal content
            updateContent(originalReq, item.propPath.replace(/^req\./, ''), remoteFileContent)
          }
        }))
      }

      await Promise.all(filesToSave.map(async (info) => {
        await saveContentFileAndUpdate(
          data,
          info.propPath,
          info.file,
          info.path,
          info.content
        )
      }))

      reqData.data = data

      if (isRemote) {
        return [reqData, {
          remoteTempFiles: {
            source: `${meta.host}/api/worker-docker-temp-file`,
            tempDirectory: tempDirectory
          }
        }]
      }

      return reqData
    }
  })

  reporter.dockerManager.addContainerDelegateResponseFilterListener('generalFilter', async ({ type, resData, meta }) => {
    const isRemote = meta.remote
    const fromRemoteEnd = meta.fromRemoteEnd
    const tempDirectory = meta.requestAutoCleanupTempDirectory

    const readFileFromRemote = createRemoteFileReader({
      authentication: reporter.authentication ? {
        username: reporter.options.extensions.authentication.admin.username,
        password: reporter.options.extensions.authentication.admin.password
      } : undefined,
      timeout: meta.delegateTimeout
    })

    const filesToRead = []
    const data = resData

    if (fromRemoteEnd) {
      data.remoteTempFiles = {
        source: `${meta.host}/api/worker-docker-temp-file`,
        tempDirectory: tempDirectory
      }

      return data
    }

    if (type === 'scriptManager') {
      if (data.action != null && data.data) {
        if (data.data.parentReq && data.data.parentReq.template && data.data.parentReq.template.content) {
          filesToRead.push({
            path: path.join(tempDirectory, data.data.parentReq.template.content.file),
            type: data.data.parentReq.template.content.type,
            propPath: 'data.parentReq.template.content'
          })
        }

        if (data.data.req && data.data.req.template && data.data.req.template.content) {
          filesToRead.push({
            path: path.join(tempDirectory, data.data.req.template.content.file),
            type: data.data.req.template.content.type,
            propPath: 'data.req.template.content'
          })
        }

        if (data.data.originalReq && data.data.originalReq.template && data.data.originalReq.template.content) {
          filesToRead.push({
            path: path.join(tempDirectory, data.data.originalReq.template.content.file),
            type: data.data.originalReq.template.content.type,
            propPath: 'data.originalReq.template.content'
          })
        }
      }

      if (data.content) {
        filesToRead.push({
          path: path.join(tempDirectory, data.content.file),
          type: data.content.type,
          propPath: 'content'
        })
      }

      if (data.request && data.request.template && data.request.template.content) {
        filesToRead.push({
          path: path.join(tempDirectory, data.request.template.content.file),
          type: data.request.template.content.type,
          propPath: 'request.template.content'
        })
      }

      if (data.response && data.response.content) {
        filesToRead.push({
          path: path.join(tempDirectory, data.response.content.file),
          type: data.response.content.type,
          propPath: 'response.content'
        })
      }

      if (data.pdfContent) {
        filesToRead.push({
          path: path.join(tempDirectory, data.pdfContent.file),
          type: data.pdfContent.type,
          propPath: 'pdfContent'
        })
      }
    } else if (type === 'recipe') {
      if (data.action != null && data.data) {
        if (data.data.parentReq && data.data.parentReq.template && data.data.parentReq.template.content) {
          filesToRead.push({
            path: path.join(tempDirectory, data.data.parentReq.template.content.file),
            type: data.data.parentReq.template.content.type,
            propPath: 'data.parentReq.template.content'
          })
        }

        if (data.data.req && data.data.req.template && data.data.req.template.content) {
          filesToRead.push({
            path: path.join(tempDirectory, data.data.req.template.content.file),
            type: data.data.req.template.content.type,
            propPath: 'data.req.template.content'
          })
        }
      }

      if (data.req && data.req.template && data.req.template.content) {
        filesToRead.push({
          path: path.join(tempDirectory, data.req.template.content.file),
          type: data.req.template.content.type,
          propPath: 'req.template.content'
        })
      }

      if (data.res && data.res.content) {
        filesToRead.push({
          path: path.join(tempDirectory, data.res.content.file),
          type: data.res.content.type,
          propPath: 'res.content'
        })
      }
    }

    if (filesToRead.length > 0) {
      await Promise.all(filesToRead.map(async (info) => {
        if (isRemote) {
          const currentContent = get(data, info.propPath)

          await readContentFromRemoteAndRestore(data, info.propPath, meta.remoteTempFiles.source, {
            file: path.join(meta.remoteTempFiles.tempDirectory, currentContent.file),
            type: currentContent.type
          }, readFileFromRemote)
        } else {
          await readContentFileAndRestore(data, info.propPath, info.path, info.type)
        }
      }))

      return data
    }
  })
}

function updateContent (data, propPath, content) {
  const parts = propPath.split('.')
  const partsLastIndex = parts.length - 1
  let parent = data

  parts.forEach((part, idx) => {
    if (idx === partsLastIndex) {
      parent[part] = content
    } else {
      parent[part] = Object.assign({}, parent[part])
      parent = parent[part]
    }
  })
}

function createRemoteFileReader ({ authentication, timeout }) {
  return async (url, fileInfo, options = {}) => {
    const opts = {
      ...options,
      params: {
        file: fileInfo.file,
        type: fileInfo.type
      },
      responseType: fileInfo.type === 'buffer' ? 'arraybuffer' : 'text',
      timeout,
      // no limits for http response content body size.
      // axios by default has no limits but there is a bug
      // https://github.com/axios/axios/issues/1362 (when following redirects) in
      // which the default limit is not taking into account, so we set it explicetly
      maxContentLength: Infinity
    }

    if (authentication) {
      opts.auth = {
        username: authentication.username,
        password: authentication.password
      }
    }

    const response = await axios.get(url, opts)

    return response.data
  }
}

async function saveContentFileAndUpdate (data, propPath, file, pathToSave, content) {
  updateContent(data, propPath, {
    type: typeof content === 'string' ? 'string' : 'buffer',
    file
  })

  await writeFileAsync(pathToSave, content)
}

async function readContentFromRemoteAndRestore (data, propPath, url, fileInfo, readFileFromRemote) {
  let content = await readFileFromRemote(url, fileInfo)
  set(data, propPath, content)
}

async function readContentFileAndRestore (data, propPath, pathToContent, type) {
  let content = await readFileAsync(pathToContent)

  if (type !== 'string' && type !== 'buffer') {
    throw new Error(`Invalid content type "${type}" found when trying to read content from temp file`)
  }

  if (type === 'string') {
    content = content.toString()
  }

  set(data, propPath, content)
}
