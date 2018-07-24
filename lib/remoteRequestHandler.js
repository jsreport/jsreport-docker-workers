module.exports = (serializer, executeScript, executeRecipe) => (req, res, next) => {
  (async () => {
    if (!req.body.payload) {
      throw new Error('request to worker (remote) must contain ".payload" property in body')
    }

    const body = serializer.deserialize(Buffer.from(req.body.payload, 'hex'))
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

    if (type === 'scriptManager') {
      const scriptResult = await executeScript(
        reqInput.inputs,
        reqInput.options,
        jsreportReq
      )

      const responsePayloadBuffer = serializer.serialize(scriptResult)

      return res.json({
        payload: responsePayloadBuffer.toString('hex')
      })
    }

    if (type === 'recipe') {
      const recipeResult = await executeRecipe(
        reqInput.recipe,
        jsreportReq,
        reqInput.res,
        true
      )

      const responsePayloadBuffer = serializer.serialize({
        req: recipeResult.req,
        res: recipeResult.res
      })

      return res.json({
        payload: responsePayloadBuffer.toString('hex')
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
