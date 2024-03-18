import { joinURL, withQuery } from 'ufo'
import type { NitroErrorHandler } from 'nitropack'
import type { H3Error } from 'h3'
import { getRequestHeaders, send, setResponseHeader, setResponseStatus } from 'h3'
import { useRuntimeConfig } from '#internal/nitro'
import { useNitroApp } from '#internal/nitro/app'
import { isJsonRequest, normalizeError } from '#internal/nitro/utils'
import type { NuxtPayload } from '#app'

export default <NitroErrorHandler> async function errorhandler (error: H3Error, event) {
  // Parse and normalize error
  const { stack, statusCode, statusMessage, message } = normalizeError(error)

  let errorStr = ''
  let consoleStr = ''
  for (const i of stack) {
    errorStr += `<span class="stack${i.internal ? ' internal' : ''}">${i.text}</span>\n`
    consoleStr += '  ' + i.text + '  \n'
  }
  // Create an error object
  const errorObject = {
    url: event.path,
    statusCode,
    statusMessage,
    message,
    stack: import.meta.dev && statusCode !== 404
      ? `<pre>${errorStr.slice(0,-1)}</pre>`
      : '',
    // TODO: check and validate error.data for serialisation into query
    data: error.data as any
  } satisfies Partial<NuxtPayload['error']> & { url: string }

  // Console output
  if (error.unhandled || error.fatal) {
    let tags = `[nuxt] [request error] ${error.unhandled ? '[unhandled]' : ''} ${error.fatal ? '[fatal]' : ''}${Number(errorObject.statusCode) !== 200 ? ` [${errorObject.statusCode}]` : ''}` 
    console.error(tags, errorObject.message + '\n' + consoleStr.slice(0,-3))
  }

  if (event.handled) { return }

  // Set response code and message
  setResponseStatus(event, (errorObject.statusCode !== 200 && errorObject.statusCode) as any as number || 500, errorObject.statusMessage)

  // JSON response
  if (isJsonRequest(event)) {
    setResponseHeader(event, 'Content-Type', 'application/json')
    return send(event, JSON.stringify(errorObject))
  }

  // Access request headers
  const reqHeaders = getRequestHeaders(event)

  // Detect to avoid recursion in SSR rendering of errors
  const isRenderingError = event.path.startsWith('/__nuxt_error') || !!reqHeaders['x-nuxt-error']

  // HTML response (via SSR)
  const res = isRenderingError
    ? null
    : await useNitroApp().localFetch(
      withQuery(joinURL(useRuntimeConfig(event).app.baseURL, '/__nuxt_error'), errorObject),
      {
        headers: { ...reqHeaders, 'x-nuxt-error': 'true' },
        redirect: 'manual'
      }
    ).catch(() => null)

  // Fallback to static rendered error page
  if (!res) {
    const { template } = import.meta.dev
      // @ts-expect-error TODO: add legacy type support for subpath imports
      ? await import('@nuxt/ui-templates/templates/error-dev.mjs')
      // @ts-expect-error TODO: add legacy type support for subpath imports
      : await import('@nuxt/ui-templates/templates/error-500.mjs')
    if (import.meta.dev) {
      // TODO: Support `message` in template
      (errorObject as any).description = errorObject.message
    }
    if (event.handled) { return }
    setResponseHeader(event, 'Content-Type', 'text/html;charset=UTF-8')
    return send(event, template(errorObject))
  }

  const html = await res.text()
  if (event.handled) { return }

  for (const [header, value] of res.headers.entries()) {
    setResponseHeader(event, header, value)
  }
  setResponseStatus(event, res.status && res.status !== 200 ? res.status : undefined, res.statusText)

  return send(event, html)
}
