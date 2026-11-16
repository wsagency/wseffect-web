import { embed as runtimeEmbed, type MakeRuntimeReturn } from '@wsagency/wseffect-foldkit/runtime'

export type IslandProgram = MakeRuntimeReturn<any, any, any, 'Element'>
export type IslandEntry = (host: HTMLElement) => IslandProgram

/** Mount one scoped Foldkit program and release every runtime-owned resource as soon as its host leaves the document. */
export function watchRemoval(
  host: Pick<HTMLElement, 'isConnected' | 'ownerDocument'>,
  disposeRuntime: () => void,
  Observer: typeof MutationObserver = MutationObserver,
): () => void {
  let disposed = false
  let observer: MutationObserver
  const dispose = () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    disposeRuntime()
  }
  observer = new Observer(() => {
    if (!host.isConnected) dispose()
  })
  observer.observe(host.ownerDocument, { childList: true, subtree: true })
  if (!host.isConnected) dispose()
  return dispose
}

/** Mount one scoped Foldkit program and release every runtime-owned resource as soon as its host leaves the document. */
export function mountIsland(host: HTMLElement, entry: IslandEntry): { dispose(): void } {
  const runtime = runtimeEmbed(entry(host))
  const stopWatching = watchRemoval(host, () => runtime.dispose())
  return { dispose: stopWatching }
}
