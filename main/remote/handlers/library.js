const library = require('../../application/library-service')
const { readBody, sendJson } = require('../http-utils')
const { libraryPageRequestSchema } = require('../../../packages/contracts')

function createLibraryHandlers({ getRequestToken }) {
  const token = (req, url = new URL(req.url, 'http://localhost')) => getRequestToken(req, url, false)
  return {
    async handleLibrary(req, res, url) { return sendJson(req, res, 200, await library.getLegacyLibrary(url, token(req, url))) },
    async handleLibraryQuery(req, res) {
      const request = libraryPageRequestSchema.parse(await readBody(req))
      return sendJson(req, res, 200, await library.queryLibrary(request, token(req)))
    },
    async handleLibraryRevision(req, res) { return sendJson(req, res, 200, await library.getLibraryRevision()) },
    async handleLibraryCategories(req, res, url) {
      return sendJson(req, res, 200, await library.queryLibraryCategories(url.searchParams.get('type'), url.searchParams.get('cursor'), token(req, url)))
    }
  }
}
module.exports = { ...library, createLibraryHandlers }
