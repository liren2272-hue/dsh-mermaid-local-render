/**
 * dsh-mermaid — Host half.
 *
 * The Client half (`client.js`) registers a `mermaid` layer on Chat's
 * `conversation.chat.markdown.fence` slot and renders the diagram in the page.
 * This half only serves the one artifact the page cannot reach on its own: the
 * mermaid bundle. It lives inside this plugin's directory (`mermaid.min.js`),
 * so the renderer stays self-contained — no CDN, no file outside the bundle.
 *
 * The transport is the same `webServer` prefix route the other local plugins
 * use: the page resolves the URL against `document.baseURI` (so a reverse-proxy
 * prefix keeps working) and the Host answers with the file bytes.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MERMAID_FILE = join(HERE, 'mermaid.min.js')

/** Prefix the Client half asks for; no trailing slash (see dsh-browser-links). */
const ROUTE_PREFIX = '/dsh-mermaid'

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-cache' }, headers ?? {}))
  res.end(body)
}

/**
 * Register the static routes.
 * @param ctx - the plugin context; `webServer` is injected below.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(
      () =>
        sctx.webServer.register(
          {
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: (req, res) => {
              try {
                const url = new URL(req.url ?? '/', 'http://dsh.local')
                const parts = url.pathname.split('/').filter(Boolean)
                if (parts[0] !== 'dsh-mermaid') return send(res, 404, 'not found')

                if (parts[1] === 'mermaid.min.js') {
                  const body = readFileSync(MERMAID_FILE)
                  return send(res, 200, body, {
                    'Content-Type': 'application/javascript; charset=utf-8',
                  })
                }

                if (parts[1] === 'config') {
                  return send(res, 200, JSON.stringify({ enabled: true }), {
                    'Content-Type': 'application/json; charset=utf-8',
                  })
                }

                return send(res, 404, 'not found')
              } catch (error) {
                ctx.logger?.warn?.(`dsh-mermaid: route failed: ${String((error && error.message) || error)}`)
                try {
                  send(res, 500, 'internal error')
                } catch {
                  // The socket may already be gone; nothing useful left to do.
                }
              }
            },
          },
          'dsh-mermaid: static routes',
        ),
    )
  })
}
