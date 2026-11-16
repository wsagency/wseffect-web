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

let nextIslandId = 0

/** Keep Astro's stable host while Foldkit owns a uniquely identified child container. */
export function mountIsland(host: HTMLElement, entry: IslandEntry): { dispose(): void } {
  const target = host.ownerDocument.createElement('div')
  const name = host.dataset.island?.replace(/[^a-zA-Z0-9_-]/g, '-') || 'embedded'
  let id = ''
  do {
    id = `wseffect-island-${name}-${nextIslandId++}`
  } while (host.ownerDocument.getElementById(id))
  target.id = id
  host.replaceChildren(target)
  const runtime = runtimeEmbed(entry(target))
  const stopWatching = watchRemoval(host, () => runtime.dispose())
  return { dispose: stopWatching }
}
