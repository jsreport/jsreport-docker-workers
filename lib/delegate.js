const axios = require('axios')
const uuid = require('uuid')
const extend = require('node.extend')
const omit = require('lodash.omit')

module.exports = (reporter, { onRequestFilter, onResponseFilter, onContainerError }) => {
  async function axiosPost (url, data, opts) {
    try {
      const dataToSend = await onRequestFilter(data)

      const response = await axios.post(url, {
        payload: dataToSend
      }, opts)

      if (!response.data.payload) {
        throw new Error('response from worker must contain ".payload" property in body')
      }

      response.data = await onResponseFilter(response.data.payload)

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
    async delegateScript (url, remote, inputs, options, req) {
      const type = 'scriptManager'

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
          options
        }
      }

      if (remote === true) {
        requestInput.data.req = req
      } else {
        requestInput.uuid = uuid()
      }

      const reqOptions = {}

      if (remote === true && reporter.authentication) {
        const authOptions = reporter.options.extensions.authentication

        reqOptions.auth = {
          username: authOptions.admin.username,
          password: authOptions.admin.password
        }
      }

      try {
        resp = await axiosPost(url, requestInput, reqOptions)
        return resp.data
      } catch (e) {
        if (onContainerError) {
          await onContainerError({
            type,
            error: e,
            data: {
              req: req,
              body: requestInput
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
        // jsreport has in content buffer which is harder to serialize
        // but we can send already string to the worker
        res.content = res.content.toString()

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

          resp = await axiosPost(url, requestInput, reqOptions)
        } else {
          requestInput.uuid = req.context.uuid

          resp = await axiosPost(url, requestInput)

          while (resp.data.action === 'render') {
            const respBody = resp.data

            reporter.logger.debug(`Processing render callback from worker`)

            const renderRes = await reporter.render(respBody.data.req, req)

            const childRenderRequestInput = {
              content: renderRes.content.toString(),
              req
            }

            currentRequestInput = childRenderRequestInput

            resp = await axiosPost(url, {
              uuid: req.context.uuid,
              data: childRenderRequestInput
            })
          }
        }

        extend(true, req, omit(resp.data.req, ['data']))
        req.data = resp.data.req.data

        extend(true, res, resp.data.res)

        res.content = Buffer.from(res.content, 'base64')

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
