const axios = require('axios')
const uuid = require('uuid')
const extend = require('node.extend')
const omit = require('lodash.omit')

function extendRenderRequest (originalReq, copyReq) {
  extend(true, originalReq, omit(copyReq, ['data']))
  originalReq.data = copyReq.data
}

module.exports = (reporter, { delegateTimeout, onRequestFilter, onResponseFilter, onContainerError }) => {
  async function axiosPost (type, url, originalReq, data, opts) {
    try {
      const dataToSend = await onRequestFilter(type, originalReq, data)

      const response = await axios.post(url, {
        payload: dataToSend
      }, Object.assign({
        timeout: delegateTimeout
      }, opts))

      if (!response.data.payload) {
        throw new Error('response from worker must contain ".payload" property in body')
      }

      response.data = await onResponseFilter(type, originalReq, response.data.payload)

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

      // when request is from remote then the inputs.response.content is already in base64
      if (fromRemote !== true) {
        if (inputs.response && inputs.response.content) {
          inputs.response = Object.assign({}, inputs.response)

          inputs.response.content = (
            Buffer.isBuffer(inputs.response.content) ? inputs.response.content : Buffer.from(inputs.response.content)
          ).toString('base64')
        }
      }

      const requestInput = {
        type,
        data: {
          inputs,
          options
        }
      }

      if (remote === true) {
        requestInput.data.req = req
      } else {
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
        resp = await axiosPost(type, url, req, requestInput, reqOptions)

        if (remote === true) {
          return resp.data
        }

        while (resp.data.action === 'render') {
          const respBody = resp.data

          reporter.logger.debug(`Processing render callback (script) from worker`)

          if (respBody.data.parentReq) {
            extendRenderRequest(req, respBody.data.parentReq)
          }

          const renderRes = await reporter.render(respBody.data.req, req)

          const childRenderRequestInput = {
            content: (Buffer.isBuffer(renderRes.content) ? renderRes.content : Buffer.from(renderRes.content)).toString('base64'),
            meta: renderRes.meta,
            req
          }

          currentRequestInput = childRenderRequestInput

          resp = await axiosPost(type, url, req, {
            uuid: requestInput.uuid,
            data: childRenderRequestInput
          })
        }

        if (resp.data.response && resp.data.response.content) {
          resp.data.response.content = Buffer.from(resp.data.response.content, 'base64')
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
        // when request is from remote then the res.content is already in base64
        if (fromRemote !== true) {
          // jsreport has in content buffer which is harder to serialize
          // but we can send already string to the worker
          res.content = (
            Buffer.isBuffer(res.content) ? res.content : Buffer.from(res.content)
          ).toString('base64')
        }

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

          resp = await axiosPost(type, url, req, requestInput, reqOptions)
        } else {
          requestInput.uuid = req.context.uuid

          resp = await axiosPost(type, url, req, requestInput)

          while (resp.data.action === 'render') {
            const respBody = resp.data

            reporter.logger.debug(`Processing render callback (recipe) from worker`)

            if (respBody.data.parentReq) {
              extendRenderRequest(req, respBody.data.parentReq)
            }

            const renderRes = await reporter.render(respBody.data.req, req)

            const childRenderRequestInput = {
              content: (Buffer.isBuffer(renderRes.content) ? renderRes.content : Buffer.from(renderRes.content)).toString('base64'),
              meta: renderRes.meta,
              req
            }

            currentRequestInput = childRenderRequestInput

            resp = await axiosPost(type, url, req, {
              uuid: req.context.uuid,
              data: childRenderRequestInput
            })
          }
        }

        extendRenderRequest(req, resp.data.req)

        extend(true, res, resp.data.res)

        if (!fromRemote) {
          res.content = Buffer.from(res.content, 'base64')
        }

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
