export type DeviceFocus = { deviceId: string, bindingId?: string }
type FocusSnapshot = { kind: 'none' | 'ambiguous' } | { kind: 'global', owner: symbol } | ({ kind: 'device', owner: symbol } & DeviceFocus)

// Navigation owns only IDs here; this registry never retains credentials, endpoints or a screen/store.
const owners = new Map<symbol, DeviceFocus | null>()
const listeners = new Set<() => void>()
let snapshot: FocusSnapshot = { kind: 'none' }

function publish() {
  let next: FocusSnapshot
  if (!owners.size) next = { kind: 'none' }
  else if (owners.size > 1) next = { kind: 'ambiguous' }
  else {
    const [owner, focus] = owners.entries().next().value!
    next = focus ? { kind: 'device', owner, ...focus } : { kind: 'global', owner }
  }
  const same = snapshot.kind === next.kind &&
    (!('owner' in snapshot) || 'owner' in next && snapshot.owner === next.owner) &&
    (snapshot.kind !== 'device' || next.kind === 'device' && snapshot.deviceId === next.deviceId && snapshot.bindingId === next.bindingId)
  if (same) return
  snapshot = next
  listeners.forEach(listener => { try { listener() } catch { /* Observers cannot interrupt navigation. */ } })
}
export function publishDeviceFocus(owner: symbol, focus: DeviceFocus | null) {
  owners.set(owner, focus ? { ...focus } : null); publish()
}
export function releaseDeviceFocus(owner: symbol) { owners.delete(owner); publish() }
export const getActiveDeviceContext = () => snapshot
export function subscribeActiveDeviceContext(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export const activeDeviceContextDiagnostics = () => ({ owners: owners.size, listeners: listeners.size, kind: snapshot.kind })
