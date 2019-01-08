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
          file: tmpFilename,
          propPath: 'req.template.content',
          content: data.req.template.content
        })
      }

      if (data.inputs) {
        if (data.inputs.template && data.inputs.template.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-template.txt`

          filesToSave.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
            file: tmpFilename,
            propPath: 'inputs.template.content',
            content: data.inputs.template.content
          })
        }

        if (data.inputs.request && data.inputs.request.template && data.inputs.request.template.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-req-template.txt`

          filesToSave.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
            file: tmpFilename,
            propPath: 'inputs.request.template.content',
            content: data.inputs.request.template.content
          })
        }

        if (data.inputs.response && data.inputs.response.content) {
          const tmpFilename = `${type}-${uuid}-request-inputs-res-content.txt`

          filesToSave.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
            file: tmpFilename,
            propPath: 'inputs.response.content',
            content: data.inputs.response.content
          })
        }

        if (data.inputs.pdfContent) {
          const tmpFilename = `${type}-${uuid}-request-inputs-pdfcontent.txt`

          filesToSave.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
            file: tmpFilename,
            propPath: 'inputs.pdfContent',
            content: data.inputs.pdfContent
          })
        }
      }
    } else if (type === 'recipe') {
      if (data.req && data.req.template && data.req.template.content) {
        const tmpFilename = `${type}-${uuid}-request-req-template.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          file: tmpFilename,
          propPath: 'req.template.content',
          content: data.req.template.content
        })
      }

      if (data.res && data.res.content) {
        const tmpFilename = `${type}-${uuid}-request-res-content.txt`

        filesToSave.push({
          path: path.join(meta.requestAutoCleanupTempDirectory, tmpFilename),
          file: tmpFilename,
          propPath: 'res.content',
          content: data.res.content
        })
      }
    }

    if (filesToSave.length > 0) {
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
      if (data.action != null && data.data) {
        if (data.data.parentReq && data.data.parentReq.template && data.data.parentReq.template.content) {
          filesToRead.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, data.data.parentReq.template.content.file),
            type: data.data.parentReq.template.content.type,
            propPath: 'data.parentReq.template.content'
          })
        }

        if (data.data.req && data.data.req.template && data.data.req.template.content) {
          filesToRead.push({
            path: path.join(meta.requestAutoCleanupTempDirectory, data.data.req.template.content.file),
            type: data.data.req.template.content.type,
            propPath: 'data.req.template.content'
          })
        }
      }

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
        await readContentFileAndRestore(data, info.propPath, info.path, info.type)
      }))

      return data
    }
  })
}

async function saveContentFileAndUpdate (data, propPath, file, pathToSave, content) {
  const parts = propPath.split('.')
  const partsLastIndex = parts.length - 1
  let parent = data

  parts.forEach((part, idx) => {
    if (idx === partsLastIndex) {
      parent[part] = {
        type: typeof parent[part] === 'string' ? 'string' : 'buffer',
        file
      }
    } else {
      parent[part] = Object.assign({}, parent[part])
      parent = parent[part]
    }
  })

  await writeFileAsync(pathToSave, content)
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
