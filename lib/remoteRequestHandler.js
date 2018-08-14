module.exports = (executeScript, executeRecipe, { onRequestFilter, onResponseFilter } = {}) => (req, res, next) => {
  (async () => {
    if (!req.body.payload) {
      throw new Error('request to worker (remote) must contain ".payload" property in body')
    }

    const body = req.body.payload
    const type = body.type
    const reqInput = body.data
    const jsreportReq = reqInput.req

    // we need to define __isJsreportRequest__ to avoid error in render
    // from parent request
    Object.defineProperty(jsreportReq, '__isJsreportRequest__', {
      value: true,
      writable: false,
      configurable: false,
      enumerable: false
    })

    if (onRequestFilter) {
      await onRequestFilter({
        type,
        requestBody: body,
        requestInput: reqInput,
        renderReq: jsreportReq
      })
    }

    if (type === 'scriptManager') {
      const scriptResult = await executeScript(
        reqInput.inputs,
        reqInput.options,
        jsreportReq,
        true
      )

      if (onResponseFilter) {
        await onResponseFilter({
          type,
          responseBody: scriptResult
        })
      }

      return res.json({
        payload: scriptResult
      })
    }

    if (type === 'recipe') {
      const recipeResult = await executeRecipe(
        reqInput.recipe,
        jsreportReq,
        reqInput.res,
        true
      )

      const response = {
        req: recipeResult.req,
        res: recipeResult.res
      }

      if (onResponseFilter) {
        await onResponseFilter({
          type,
          responseBody: response
        })
      }

      return res.json({
        payload: response
      })
    }

    throw new Error(`Unsuported worker action type ${type}`)
  })().catch((e) => {
    res.status(400).json({
      message: e.message,
      stack: e.stack
    })
  })
}
