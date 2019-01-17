const urlModule = require('url')
const http = require('http')
const axios = require('axios')
const uuid = require('uuid')
const extend = require('node.extend')
const omit = require('lodash.omit')
const serializator = require('serializator')

function extendRenderRequest (originalReq, copyReq) {
  extend(true, originalReq, omit(copyReq, ['data']))
  originalReq.data = copyReq.data
}

module.exports = (reporter, { useNativeHttpClient, delegateTimeout, onRequestFilter, onResponseFilter, onContainerError }) => {
  if (useNativeHttpClient) {
    reporter.logger.debug(`docker-workers: native http client is enabled for requests to containers`)
  }

  async function sendPost (type, url, originalReq, reqData, meta = {}, opts, remote) {
    const isRemote = remote === true
    const uuidStr = isRemote ? `remote-${uuid()}` : reqData.uuid

    try {
      let extraBody

      const reqFilterMeta = {
        ...meta,
        uuid: uuidStr,
        remote: isRemote,
        url
      }

      let dataToSend = await onRequestFilter({
        type,
        originalReq,
        reqData,
        meta: reqFilterMeta
      })

      if (Array.isArray(dataToSend)) {
        [dataToSend, extraBody] = dataToSend
      }

      const requestBody = {
        ...extraBody,
        payload: dataToSend
      }

      let response

      if (useNativeHttpClient) {
        response = await new Promise((resolve, reject) => {
          const urlInfo = urlModule.parse(url)
          const serializedRequestBody = serializator.serialize(requestBody)

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
      } else {
        response = await axios.post(url, requestBody, extend(true, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: delegateTimeout,
          // no limits for http response content body size.
          // axios by default has no limits but there is a bug
          // https://github.com/axios/axios/issues/1362 (when following redirects) in
          // which the default limit is not taking into account, so we set it explicetly
          maxContentLength: Infinity,
          transformRequest: [(data) => {
            return serializator.serialize(data)
          }],
          transformResponse: [(data) => {
            if (typeof data === 'string') {
              try {
                data = serializator.parse(data)
              } catch (e) {}
            }

            return data
          }]
        }, opts))
      }

      if (!response.data.payload) {
        throw new Error('response from worker must contain ".payload" property in body')
      }

      let fromRemoteEnd = false

      if (meta.fromRemote && response.data.payload.action == null) {
        fromRemoteEnd = true
      }

      const resFilterMeta = {
        ...meta,
        uuid: uuidStr,
        remote: isRemote,
        url
      }

      if (isRemote) {
        resFilterMeta.remoteTempFiles = response.data.remoteTempFiles
      } else if (fromRemoteEnd) {
        resFilterMeta.fromRemoteEnd = true
      }

      response.data = await onResponseFilter({
        type,
        originalReq,
        reqData: dataToSend,
        resData: response.data.payload,
        resBody: response.data,
        meta: resFilterMeta
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
    async delegateScript (url, remote, inputs, options, req, meta, fromRemote) {
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
        resp = await sendPost(
          type,
          url,
          req,
          requestInput,
          meta && fromRemote ? Object.assign({}, meta, { fromRemotePrimary: true }) : meta,
          reqOptions,
          remote
        )

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
              type,
              uuid: requestInput.uuid,
              data: childRenderRequestInput
            }, meta)
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
              type,
              uuid: requestInput.uuid,
              data: childRenderRequestInput
            }, meta)
          }
        }

        if (fromRemote) {
          const remoteTempFiles = resp.data.remoteTempFiles

          delete resp.data.remoteTempFiles

          return {
            result: resp.data,
            remoteTempFiles
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
    async delegateRecipe (url, remote, recipe, req, res, meta, fromRemote) {
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

          resp = await sendPost(
            type,
            url,
            req,
            requestInput,
            meta,
            reqOptions,
            remote
          )
        } else {
          requestInput.uuid = req.context.uuid

          resp = await sendPost(
            type,
            url,
            req,
            requestInput,
            meta && fromRemote ? Object.assign({}, meta, { fromRemotePrimary: true }) : meta
          )

          while (resp.data.action === 'render') {
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
              type,
              uuid: req.context.uuid,
              data: childRenderRequestInput
            }, meta)
          }
        }

        extendRenderRequest(req, resp.data.req)

        extend(true, res, resp.data.res)

        if (fromRemote === true) {
          return {
            req,
            res,
            remoteTempFiles: resp.data.remoteTempFiles
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
