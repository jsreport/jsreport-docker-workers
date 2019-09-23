const uuid = require('uuid')
const urlModule = require('url')
const http = require('http')
const extend = require('node.extend')
const omit = require('lodash.omit')
const serializator = require('serializator')

function extendRenderRequest (originalReq, copyReq) {
  extend(true, originalReq, omit(copyReq, ['data']))
  originalReq.data = copyReq.data
}

module.exports = (reporter, { delegateTimeout, onRequestFilter, onResponseFilter, onContainerError }) => {
  async function sendPost (type, url, originalReq, reqData, opts = {}, isRemote) {
    try {
      const dataToSend = await onRequestFilter({
        type,
        originalReq,
        reqData,
        meta: {
          remote: isRemote,
          url
        }
      })

      const response = await new Promise((resolve, reject) => {
        const urlInfo = urlModule.parse(url)
        const serializedRequestBody = serializator.serialize({
          payload: dataToSend
        })

        const requestOpts = {
          host: urlInfo.hostname,
          port: urlInfo.port,
          path: urlInfo.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(serializedRequestBody)
          },
          timeout: delegateTimeout
        }

        if (opts.auth) {
          requestOpts.auth = `${opts.auth.username}:${opts.auth.password}`
        }

        const postReq = http.request(requestOpts, (res) => {
          let body = Buffer.from([])

          const response = {
            status: res.statusCode
          }

          res.on('error', reject)

          res.on('data', (chunk) => {
            body = Buffer.concat([body, chunk])
          })

          res.on('end', () => {
            const d = Buffer.concat([body]).toString()
            const obj = serializator.parse(d)

            response.data = obj

            if (response.status >= 200 && response.status < 300) {
              resolve({
                data: obj
              })
            } else {
              const reqErr = new Error(`Request failed with status code ${response.status}`)
              reqErr.response = response
              reject(reqErr)
            }
          })
        })

        postReq.on('error', reject)

        postReq.write(serializedRequestBody)
        postReq.end()
      })

      if (!response.data.payload) {
        throw new Error('response from worker must contain ".payload" property in body')
      }

      response.data = await onResponseFilter({
        type,
        originalReq,
        reqData: dataToSend,
        resData: response.data.payload,
        meta: {
          remote: isRemote,
          url
        }
      })

      return response
    } catch (e) {
      if (e.response && e.response.status === 400 && e.response.data && e.response.data.message) {
        const error = reporter.createError(e.response.data.message, {
          weak: true
        })

        error.stack = e.response.data.stack
        throw error
      }

      throw e
    }
  }

  return {
    async delegateScript (url, remote, inputs, options, req, fromRemote) {
      const type = 'scriptManager'
      let currentRequestInput

      if (remote === true) {
        reporter.logger.debug(`Delegating script to external worker at ${url}`)
      } else {
        reporter.logger.debug(`Delegating script to container in local worker at ${url}`)
      }

      let resp

      const requestInput = {
        type,
        data: {
          inputs,
          options,
          req
        }
      }

      if (!remote) {
        requestInput.uuid = uuid()
      }

      currentRequestInput = requestInput

      const reqOptions = {}

      if (remote === true && reporter.authentication) {
        const authOptions = reporter.options.extensions.authentication

        reqOptions.auth = {
          username: authOptions.admin.username,
          password: authOptions.admin.password
        }
      }

      try {
        resp = await sendPost(type, url, req, requestInput, reqOptions, remote)

        if (remote === true) {
          return resp.data
        }

        while (resp.data.action != null) {
          if (resp.data.action === 'render') {
            const respBody = resp.data

            reporter.logger.debug(`Processing render callback (script) from worker`)

            if (respBody.data.parentReq) {
              extendRenderRequest(req, respBody.data.parentReq)
            }

            let errorInRender
            let renderRes

            try {
              renderRes = await reporter.render(respBody.data.req, req)
            } catch (e) {
              errorInRender = {
                message: e.message,
                stack: e.stack
              }
            }

            const childRenderRequestInput = {
              error: errorInRender,
              req
            }

            if (childRenderRequestInput.error == null) {
              childRenderRequestInput.content = renderRes.content
              childRenderRequestInput.meta = renderRes.meta
            }

            currentRequestInput = childRenderRequestInput

            resp = await sendPost(type, url, req, {
              uuid: requestInput.uuid,
              data: childRenderRequestInput
            })
          } else if (
            resp.data.action === 'documentStore.collection.find' ||
            resp.data.action === 'documentStore.collection.findOne'
          ) {
            const respBody = resp.data
            let method

            if (respBody.action === 'documentStore.collection.find') {
              method = 'find'
            } else if (respBody.action === 'documentStore.collection.findOne') {
              method = 'findOne'
            } else {
              throw new Error(`documentStore callback action "${respBody.action}" not supported`)
            }

            reporter.logger.debug(`Processing ${respBody.action} callback (script) from worker`)

            if (respBody.data.originalReq) {
              extendRenderRequest(req, respBody.data.originalReq)
            }

            let errorInQuery
            let queryRes

            try {
              const collection = reporter.documentStore.collection(respBody.data.collection)
              queryRes = await collection[method](respBody.data.query, req)
            } catch (e) {
              errorInQuery = {
                message: e.message,
                stack: e.stack
              }
            }

            const childRenderRequestInput = {
              error: errorInQuery,
              queryResult: queryRes,
              req
            }

            currentRequestInput = childRenderRequestInput

            resp = await sendPost(type, url, req, {
              uuid: requestInput.uuid,
              data: childRenderRequestInput
            })
          } else if (
            resp.data.action === 'folders.resolveEntityPath' ||
            resp.data.action === 'folders.resolveFolderFromPath'
          ) {
            const respBody = resp.data

            let method

            if (respBody.action === 'folders.resolveEntityPath') {
              method = 'resolveEntityPath'
            } else if (respBody.action === 'folders.resolveFolderFromPath') {
              method = 'resolveFolderFromPath'
            } else {
              throw new Error(`folders callback action "${respBody.action}" not supported`)
            }

            reporter.logger.debug(`Processing ${respBody.action} callback (recipe) from worker`)

            if (respBody.data.originalReq) {
              extendRenderRequest(req, respBody.data.originalReq)
            }

            let errorInFolderAction
            let folderActionRes

            try {
              const args = []

              if (method === 'resolveEntityPath') {
                args.push(respBody.data.entity)
                args.push(respBody.data.entitySet)
                args.push(req)
              } else {
                args.push(respBody.data.entityPath)
                args.push(req)
              }

              folderActionRes = await reporter.folders[method](...args)
            } catch (e) {
              errorInFolderAction = {
                message: e.message,
                stack: e.stack
              }
            }

            const childRenderRequestInput = {
              error: errorInFolderAction,
              value: folderActionRes,
              req
            }

            currentRequestInput = childRenderRequestInput

            resp = await sendPost(type, url, req, {
              uuid: requestInput.uuid,
              data: childRenderRequestInput
            })
          }
        }

        return resp.data
      } catch (e) {
        if (onContainerError) {
          await onContainerError({
            type,
            error: e,
            data: {
              req: req,
              body: currentRequestInput
            }
          })
        }

        throw e
      }
    },
    async delegateRecipe (url, remote, recipe, req, res, fromRemote) {
      const type = 'recipe'
      let currentRequestInput

      if (remote === true) {
        reporter.logger.debug(`Delegating recipe ${recipe} to external worker at ${url}`)
      } else {
        reporter.logger.debug(`Delegating recipe ${recipe} to container in local worker at ${url}`)
        req.context.uuid = uuid()
      }

      try {
        const requestInput = {
          type,
          data: {
            recipe,
            req,
            res
          }
        }

        currentRequestInput = requestInput

        let resp

        if (remote === true) {
          const reqOptions = {}

          if (reporter.authentication) {
            const authOptions = reporter.options.extensions.authentication

            reqOptions.auth = {
              username: authOptions.admin.username,
              password: authOptions.admin.password
            }
          }

          resp = await sendPost(type, url, req, requestInput, reqOptions, remote)
        } else {
          requestInput.uuid = req.context.uuid

          resp = await sendPost(type, url, req, requestInput)

          while (resp.data.action != null) {
            if (resp.data.action === 'render') {
              const respBody = resp.data

              reporter.logger.debug(`Processing render callback (recipe) from worker`)

              if (respBody.data.parentReq) {
                extendRenderRequest(req, respBody.data.parentReq)
              }

              let errorInRender
              let renderRes

              try {
                renderRes = await reporter.render(respBody.data.req, req)
              } catch (e) {
                errorInRender = {
                  message: e.message,
                  stack: e.stack
                }
              }

              const childRenderRequestInput = {
                error: errorInRender,
                req
              }

              if (childRenderRequestInput.error == null) {
                childRenderRequestInput.content = renderRes.content
                childRenderRequestInput.meta = renderRes.meta
              }

              currentRequestInput = childRenderRequestInput

              resp = await sendPost(type, url, req, {
                uuid: req.context.uuid,
                data: childRenderRequestInput
              })
            } else if (
              resp.data.action === 'documentStore.collection.find' ||
              resp.data.action === 'documentStore.collection.findOne'
            ) {
              const respBody = resp.data
              let method

              if (respBody.action === 'documentStore.collection.find') {
                method = 'find'
              } else if (respBody.action === 'documentStore.collection.findOne') {
                method = 'findOne'
              } else {
                throw new Error(`documentStore callback action "${respBody.action}" not supported`)
              }

              reporter.logger.debug(`Processing ${respBody.action} callback (recipe) from worker`)

              if (respBody.data.originalReq) {
                extendRenderRequest(req, respBody.data.originalReq)
              }

              let errorInQuery
              let queryRes

              try {
                const collection = reporter.documentStore.collection(respBody.data.collection)
                queryRes = await collection[method](respBody.data.query, req)
              } catch (e) {
                errorInQuery = {
                  message: e.message,
                  stack: e.stack
                }
              }

              const childRenderRequestInput = {
                error: errorInQuery,
                queryResult: queryRes,
                req
              }

              currentRequestInput = childRenderRequestInput

              resp = await sendPost(type, url, req, {
                uuid: requestInput.uuid,
                data: childRenderRequestInput
              })
            } else if (
              resp.data.action === 'folders.resolveEntityPath' ||
              resp.data.action === 'folders.resolveFolderFromPath'
            ) {
              const respBody = resp.data

              let method

              if (respBody.action === 'folders.resolveEntityPath') {
                method = 'resolveEntityPath'
              } else if (respBody.action === 'folders.resolveFolderFromPath') {
                method = 'resolveFolderFromPath'
              } else {
                throw new Error(`folders callback action "${respBody.action}" not supported`)
              }

              reporter.logger.debug(`Processing ${respBody.action} callback (recipe) from worker`)

              if (respBody.data.originalReq) {
                extendRenderRequest(req, respBody.data.originalReq)
              }

              let errorInFolderAction
              let folderActionRes

              try {
                const args = []

                if (method === 'resolveEntityPath') {
                  args.push(respBody.data.entity)
                  args.push(respBody.data.entitySet)
                  args.push(req)
                } else {
                  args.push(respBody.data.entityPath)
                  args.push(req)
                }

                folderActionRes = await reporter.folders[method](...args)
              } catch (e) {
                errorInFolderAction = {
                  message: e.message,
                  stack: e.stack
                }
              }

              const childRenderRequestInput = {
                error: errorInFolderAction,
                value: folderActionRes,
                req
              }

              currentRequestInput = childRenderRequestInput

              resp = await sendPost(type, url, req, {
                uuid: requestInput.uuid,
                data: childRenderRequestInput
              })
            }
          }
        }

        extendRenderRequest(req, resp.data.req)

        extend(true, res, resp.data.res)

        if (fromRemote === true) {
          return {
            req,
            res
          }
        }
      } catch (e) {
        if (onContainerError) {
          await onContainerError({
            type,
            error: e,
            data: {
              req,
              body: currentRequestInput
            }
          })
        }

        throw e
      }
    }
  }
}
