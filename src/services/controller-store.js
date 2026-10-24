export function shallowEqual(left, right) {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const kind = Object.prototype.toString.call(left)
  if (kind !== Object.prototype.toString.call(right) || !['[object Object]', '[object Array]'].includes(kind)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
}

// Published only after a React commit. Stable actions dispatch to the latest committed controller.
export class ControllerStore {
  constructor(controller) {
    this.listeners = new Set(); this.actions = Object.create(null); this.raw = controller
    this.snapshot = this.normalize(controller)
    this.subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
    this.getSnapshot = () => this.snapshot
  }
  normalize(controller) {
    return Object.freeze(Object.fromEntries(Object.entries(controller).map(([key, value]) => {
      if (typeof value !== 'function') return [key, value]
      if (!this.actions[key]) this.actions[key] = (...args) => this.raw[key](...args)
      return [key, this.actions[key]]
    })))
  }
  publish(controller) {
    this.raw = controller
    const next = this.normalize(controller)
    if (shallowEqual(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
