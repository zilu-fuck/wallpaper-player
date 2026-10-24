import { useEffect, useRef } from 'react'

const leases = new WeakMap()
function makeInert(element) {
  let state = leases.get(element)
  if (!state) { state = { count: 0, previous: element.inert }; leases.set(element, state) }
  state.count++; element.inert = true
  return () => {
    if (--state.count === 0) { element.inert = state.previous; leases.delete(element) }
  }
}
const candidates = root => [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]')]
  .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') &&
    element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')

export function useOverlayFocus(ref, active, onClose) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const root = ref.current
    if (!active || !root) return
    const opener = document.activeElement, release = []
    for (let branch = root; branch.parentElement && branch !== document.body; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && !sibling.hasAttribute('data-overlay-backdrop')) release.push(makeInert(sibling))
      }
    }
    if (!root.contains(document.activeElement)) (candidates(root)[0] || root).focus()
    const keydown = event => {
      if (event.defaultPrevented) return
      const nested = event.target.closest?.('[aria-modal="true"]')
      if (nested && nested !== root) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.(); return }
      if (event.key !== 'Tab') return
      const items = candidates(root), first = items[0], last = items.at(-1)
      if (!first) { event.preventDefault(); root.focus() }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus() }
    }
    root.addEventListener('keydown', keydown)
    return () => {
      root.removeEventListener('keydown', keydown); release.reverse().forEach(done => done())
      queueMicrotask(() => {
        const modal = document.activeElement?.closest?.('[aria-modal="true"]')
        if (modal && modal !== root) return
        if (opener?.isConnected && !opener.closest('[inert]') && opener.getClientRects().length) opener.focus()
      })
    }
  }, [ref, active])
}
