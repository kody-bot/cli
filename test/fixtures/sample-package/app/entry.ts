import { packageContext, packageStorage } from 'kody:runtime'

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        hostedUrl: packageContext.hostedUrl,
        appBasePath: packageContext.appBasePath,
      })
    }
    if (url.pathname === '/storage' && request.method === 'POST') {
      const body = (await request.json()) as { key: string; value: unknown }
      const storage = packageStorage()
      await storage.set(body.key, body.value)
      return Response.json({ ok: true })
    }
    if (url.pathname === '/storage' && request.method === 'GET') {
      const key = url.searchParams.get('key') ?? 'x'
      const storage = packageStorage()
      return Response.json({ value: await storage.get(key) })
    }
    return new Response(`hello from ${packageContext.kodyId} at ${url.pathname}`, {
      headers: { 'content-type': 'text/plain' },
    })
  },
}
