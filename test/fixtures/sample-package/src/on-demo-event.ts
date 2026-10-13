export default async function onDemoEvent(params?: {
  event?: string
  payload?: unknown
  synthetic?: boolean
}) {
  if (params?.event !== 'demo.event') {
    throw new Error(`Expected demo.event, got ${String(params?.event)}`)
  }
  return {
    handled: true,
    synthetic: params.synthetic === true,
    payload: params.payload ?? null,
  }
}
