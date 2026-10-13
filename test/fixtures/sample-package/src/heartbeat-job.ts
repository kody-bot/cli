/** Scheduler contract: no arguments. */
export default async function heartbeat() {
  return { ok: true, job: 'heartbeat' }
}
