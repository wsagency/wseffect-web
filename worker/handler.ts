export interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnvironment {
  ASSETS: AssetBinding;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export type WorkerFetch = (
  request: Request,
  env: WorkerEnvironment,
  ctx: WorkerExecutionContext,
) => Promise<Response>;

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const HASHED_ASSET = /\.[A-Za-z0-9_-]{8,}\.[^/]+$/;

function canonicalRoute(pathname: string): string | undefined {
  if (pathname.includes('\\') || pathname.includes('\0')) return undefined;
  const normalized = pathname.replace(/\/{2,}/g, '/');
  if (normalized !== pathname) return undefined;
  if (pathname === '/') return '/';
  if (pathname.endsWith('/')) return pathname;
  if (pathname.slice(pathname.lastIndexOf('/') + 1).includes('.')) return undefined;
  return `${pathname}/`;
}

interface AcceptRange {
  readonly mediaType: string;
  readonly quality: number;
}

function qualityFor(mediaType: string, ranges: readonly AcceptRange[]): number {
  let specificity = -1;
  let quality = 0;
  for (const range of ranges) {
    let candidateSpecificity = -1;
    if (range.mediaType === mediaType) candidateSpecificity = 2;
    else if (range.mediaType === '*/*') candidateSpecificity = 0;
    else if (range.mediaType.endsWith('/*') && mediaType.startsWith(range.mediaType.slice(0, -1))) {
      candidateSpecificity = 1;
    }
    if (candidateSpecificity > specificity) {
      specificity = candidateSpecificity;
      quality = range.quality;
    } else if (candidateSpecificity >= 0 && candidateSpecificity === specificity) {
      quality = Math.max(quality, range.quality);
    }
  }
  return quality;
}

function acceptsMarkdown(header: string | null): boolean {
  if (!header) return false;
  const ranges: AcceptRange[] = header.split(',').map((item) => {
    const [type = '', ...parameters] = item.trim().split(';');
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(.*?)\s*$/i.exec(parameter);
      if (match) {
        const parsed = Number(match[1]);
        quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
    }
    return { mediaType: type.trim().toLowerCase(), quality };
  });
  const canonicalMarkdownQuality = qualityFor('text/markdown', ranges);
  const markdownQuality = ranges.some((range) => range.mediaType === 'text/markdown')
    ? canonicalMarkdownQuality
    : Math.max(canonicalMarkdownQuality, qualityFor('text/x-markdown', ranges));
  const htmlQuality = Math.max(
    qualityFor('text/html', ranges),
    qualityFor('application/xhtml+xml', ranges),
  );
  return markdownQuality > 0 && markdownQuality > htmlQuality;
}

function withHeaders(response: Response, updates: Record<string, string>, method: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(updates)) headers.set(name, value);
  return new Response(method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFound(method: string, varyAccept = false): Response {
  const headers = new Headers({
    'cache-control': NO_CACHE,
    'content-type': 'text/plain; charset=utf-8',
  });
  if (varyAccept) headers.set('vary', 'Accept');
  return new Response(method === 'HEAD' ? null : 'Not Found', { status: 404, headers });
}

function methodNotAllowed(method: string): Response {
  return new Response(null, {
    status: 405,
    headers: { allow: 'GET, HEAD', 'cache-control': NO_CACHE },
  });
}

function resolveAssetPath(pathname: string): string {
  return pathname === '/' ? '/index.html' : `${pathname.replace(/\/$/, '')}/index.html`;
}

export function createWorker(routes: Readonly<Record<string, string>>): WorkerFetch {
  return async (request, env, _ctx) => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const head = method === 'HEAD';

    // This is a defensive mirror of the separately provisioned zone redirect.
    if (url.hostname.toLowerCase() === 'www.wseffect.com') {
      url.hostname = 'wseffect.com';
      return new Response(null, {
        status: 301,
        headers: { location: url.toString(), 'cache-control': NO_CACHE },
      });
    }

    if (method !== 'GET' && !head) return methodNotAllowed(method);

    const route = canonicalRoute(url.pathname);
    const hasNegotiatedRoute = route !== undefined && Object.hasOwn(routes, route);
    const varyAccept = hasNegotiatedRoute;

    if (route && hasNegotiatedRoute && route !== '/' && !url.pathname.endsWith('/')) {
      url.pathname = route;
      return new Response(null, {
        status: 308,
        headers: {
          location: url.toString(),
          'cache-control': NO_CACHE,
          ...(varyAccept ? { vary: 'Accept' } : {}),
        },
      });
    }

    if (route && hasNegotiatedRoute && acceptsMarkdown(request.headers.get('accept'))) {
      const markdownPath = routes[route];
      const markdownUrl = new URL(`/${markdownPath.replace(/^\/+/, '')}`, url.origin);
      const markdownResponse = await env.ASSETS.fetch(new Request(markdownUrl, { headers: request.headers }));
      return withHeaders(markdownResponse, { 'cache-control': NO_CACHE, vary: 'Accept' }, method);
    }

    let assetPath = url.pathname;
    if (route && hasNegotiatedRoute) assetPath = resolveAssetPath(route);
    else if (route === undefined && !url.pathname.slice(url.pathname.lastIndexOf('/') + 1).includes('.')) {
      return notFound(method);
    }

    const assetUrl = new URL(url);
    assetUrl.pathname = assetPath;
    const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, { headers: request.headers }));
    if (!assetResponse.ok) return withHeaders(assetResponse, { 'cache-control': NO_CACHE, ...(varyAccept ? { vary: 'Accept' } : {}) }, method);

    const immutable = HASHED_ASSET.test(assetPath);
    return withHeaders(
      assetResponse,
      {
        'cache-control': immutable ? IMMUTABLE : NO_CACHE,
        ...(varyAccept ? { vary: 'Accept' } : {}),
      },
      method,
    );
  };
}
