import compression from "compression"
import express, { type Request, type Response, type NextFunction } from 'express'
import { Readable } from 'node:stream'
import { runWithRequestEnv } from '@tanstack/start-env/server'
import morgan from "morgan"
import path from 'node:path'

const PORT = Number.parseInt(process.env.PORT || '3000')

// Get base path from environment, ensuring it starts with /
const rawBasePath = process.env.VITE_BASE_URL || '/'
const basePath = rawBasePath.startsWith('/') ? rawBasePath : '/' + rawBasePath

const app = express()

const assetsDir = path.join(process.cwd(), 'dist/client/assets')
const serveAssets = express.static(assetsDir, {})

// @ts-expect-error - Dynamic import of built server output
// Note: This resolves relative to the compiled output in dist/express-server.js
const { default: handler } = await import('./server/server.js')


app.use(compression());
app.disable("x-powered-by");

app.get("/healthcheck", (_: Request, res: Response) => {
  res.send("OK")
})

app.use(morgan("short"))

// check if we're in GDS
// we need to redirect our from from root back to
// the base url
// ~/ => ~/my-app
// Serve rewrite / to /<gds-path>
app.use((req: Request, _: Response, next: NextFunction) => {
  const pathOnly = req.path
  const segments = pathOnly.split('/').filter(Boolean)

  const svc = req.get('x-gds-service-name') || req.get('X-GDS-Service-Name')

  // Expect at least /<prefix>/assets
  if (svc && segments.length > 0 && segments[0] !== svc) {
    const newUrl = `/${svc}${req.url}`;
    req.url = newUrl;
    req.originalUrl = newUrl;
  }

  next();
})

// Serve /<prefix>/assets/* from dist/client/assets where `assets` is the second segment
app.use((req: Request, res: Response, next: NextFunction) => {
  const pathOnly = req.path
  const segments = pathOnly.split('/').filter(Boolean)

  // Expect at least /<prefix>/assets
  if (segments.length < 2 || segments[1] !== 'assets') {
    return next()
  }

  // Everything after /<prefix>/assets becomes the asset path
  const tailSegments = segments.slice(2)
  const assetPath = '/' + tailSegments.join('/')
  const finalAssetPath = assetPath === '/' ? '/' : assetPath

  const originalUrl = req.url

  req.url = finalAssetPath

  serveAssets(req, res, (err?: any) => {
    req.url = originalUrl
    if (err) return next(err)
    return next()
  })
})

// Serve static assets at the dynamic base path
app.use(basePath, express.static('dist/client', {}))

function computeBaseForRequest(req: Request): string {
  const svc = req.get('x-gds-service-name') || req.get('X-GDS-Service-Name')
  if (svc && svc.trim()) {
    const base = `/${svc.trim()}`
    return base.endsWith('/') ? base : base + '/'
  }

  const rawEnvBase = process.env.VITE_BASE_URL || '/'
  const withLeading = rawEnvBase.startsWith('/') ? rawEnvBase : '/' + rawEnvBase
  return withLeading.endsWith('/') ? withLeading : withLeading + '/'
}

function getPublicEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VITE_') && typeof value === 'string') {
      out[key] = value
    }
  }
  return out
}

function injectBootstrap(html: string, publicEnv: Record<string, string>, basePath: string): string {
  const base = basePath.endsWith('/') ? basePath : basePath + '/'

  const bootstrapScript =
    `<script>(function(){` +
    `window.__BASE__=${JSON.stringify(base)};` +
    `window.__ENV__=${JSON.stringify(publicEnv)};` +
    `var s=document.currentScript;if(s&&s.parentNode){s.parentNode.removeChild(s);}` +
    `}())</script>`

  return html.replace(/<head([^>]*)>/, `<head$1>${bootstrapScript}`)
}

app.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const origin = `${req.protocol}://${req.get('host')}`
    const url = origin + req.originalUrl

    const isBodyMethod = req.method !== 'GET' && req.method !== 'HEAD'

    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers: req.headers as any,
      body: isBodyMethod ? (req as any) : undefined,
      duplex: isBodyMethod ? 'half' : undefined,
    }

    const basePath = computeBaseForRequest(req)
    const publicEnv = getPublicEnv()
    publicEnv.VITE_BASE_URL = basePath

    await runWithRequestEnv(
      { basePath, publicEnvOverride: publicEnv },
      async () => {
        const webReq = new Request(url, init as RequestInit)
        const webRes = await handler.fetch(webReq, {
          context: {
            runtimeBase: basePath,
            publicEnv,
          },
        })

        const contentType = webRes.headers.get('content-type') || ''

        if (contentType.includes('text/html')) {
          const html = await webRes.text()
          const injected = injectBootstrap(html, publicEnv, basePath)

          res.status(webRes.status)
          webRes.headers.forEach((value: string, name: string) => res.setHeader(name, value))
          res.send(injected)
          return
        }

        // Non-HTML responses (e.g. server functions): stream body
        res.status(webRes.status)
        webRes.headers.forEach((value: string, name: string) => res.setHeader(name, value))

        if (webRes.body) {
          const nodeStream = Readable.fromWeb(webRes.body as any)
          nodeStream.pipe(res)
        } else {
          res.end()
        }
      },
    )
  } catch (error) {
    next(error)
  }
})

const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}${basePath}`)
  console.log(`Base path: ${basePath}`)
})

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down gracefully...`)
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('Forcing shutdown...')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
