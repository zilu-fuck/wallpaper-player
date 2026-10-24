import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export type PlayerSheetKind = 'more' | 'tags' | 'analysis'
export type PlayerSheetLease = { kind: PlayerSheetKind; owner: string; generation: number }

export function usePlayerSheet(owner: string, active: boolean) {
  const [selection, setSelection] = useState<PlayerSheetLease | null>(null)
  const [noticeState, setNotice] = useState<{ lease: PlayerSheetLease; text: string } | null>(null)
  const currentRef = useRef<PlayerSheetLease | null>(null)
  const ownerRef = useRef(owner), activeRef = useRef(active), mounted = useRef(true), sequence = useRef(0)
  ownerRef.current = owner; activeRef.current = active
  const isCurrent = useCallback((lease: PlayerSheetLease | null) => Boolean(lease && mounted.current &&
    currentRef.current === lease && lease.owner === ownerRef.current), [])
  const close = useCallback((lease: PlayerSheetLease | null) => {
    if (!isCurrent(lease)) return false
    currentRef.current = null; setSelection(null); setNotice(null); return true
  }, [isCurrent])
  const open = useCallback((kind: PlayerSheetKind) => {
    if (!mounted.current || ownerRef.current !== owner || !activeRef.current) return null
    const lease = { kind, owner, generation: ++sequence.current }
    currentRef.current = lease; setSelection(lease); setNotice(null); return lease
  }, [owner])
  const run = useCallback(<T,>(lease: PlayerSheetLease | null, action: () => T): T | undefined => {
    if (activeRef.current && isCurrent(lease)) return action()
  }, [isCurrent])
  const notify = useCallback((text: string) => {
    const lease = currentRef.current
    if (!lease || !isCurrent(lease)) return false
    setNotice({ lease, text }); return true
  }, [isCurrent])
  useLayoutEffect(() => {
    if (currentRef.current?.owner !== owner) { currentRef.current = null; setSelection(null); setNotice(null) }
  }, [owner])
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; currentRef.current = null }
  }, [])
  const current = selection?.owner === owner ? selection : null
  return { current, presented: active ? current : null, currentRef, open, close, isCurrent, run, notify,
    notice: noticeState?.lease === current ? noticeState?.text || '' : '' }
}
