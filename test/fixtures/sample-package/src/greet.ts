export default async function greet(params?: { name?: string; webhook?: unknown; request?: unknown }) {
  if (params && 'request' in params && params.request) {
    return { webhook: true, body: (params.request as { body?: string }).body ?? null }
  }
  return { hello: params?.name ?? 'world' }
}
