module.exports = (executeScript, executeRecipe) => (req, res, next) => {
  (async () => {
    const type = req.body.type
    const reqInput = req.body.data
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

      return res.json(scriptResult)
    }

    if (type === 'recipe') {
      const recipeResult = await executeRecipe(
        reqInput.recipe,
        jsreportReq,
        reqInput.res,
        true
      )

      return res.json({
        req: recipeResult.req,
        res: recipeResult.res
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
