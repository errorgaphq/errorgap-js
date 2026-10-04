# @errorgap/browser

Browser notifier for [Errorgap](https://errorgap.com). Captures uncaught
errors and unhandled promise rejections, parses cross-browser stack traces,
and ships notices to an Errorgap server. Includes an opt-in React error
boundary and opt-in browser performance monitoring (page loads, in-app
navigations, Core Web Vitals and fetch/XHR timings).

When production source maps are available, the SDK resolves generated frames
to their original files and sends a bounded source excerpt with each frame.
This makes application and vendor source immediately available in Errorgap
without a repository integration. Missing or inaccessible maps gracefully
fall back to the generated stack trace.

## Install

```sh
npm install @errorgap/browser
```

Or via CDN (UMD/IIFE bundle exposes `window.Errorgap`):

```html
<script src="https://cdn.jsdelivr.net/npm/@errorgap/browser"></script>
<script>
  Errorgap.init({
    endpoint:    "https://errorgap.example.com",
    projectSlug: "your-project",
    apiKey:      "flk_...",
  });
</script>
```

## Configure

Initialize as early as possible in the app entry point:

```ts
import { Errorgap } from "@errorgap/browser";

Errorgap.init({
  endpoint:    "https://errorgap.example.com",
  projectSlug: "your-project",
  apiKey:      "flk_...",
  environment: "production",
  release:     __APP_VERSION__,
});
```

`init` installs `window` listeners for `error` and `unhandledrejection` by
default — pass `captureGlobals: false` to skip.

## Manual notification

```ts
try {
  await risky();
} catch (err) {
  await Errorgap.notify(err, { context: { component: "checkout" } });
  throw err;
}
```

`notify` returns a `DeliveryResult` (`{ status, body }` on success,
`{ error }` on failure, `{ queued: true, status: 202 }` in async mode,
`{ sampled: true }` if dropped by `sampleRate`). The SDK never throws.

## React

```tsx
import { ErrorgapBoundary } from "@errorgap/browser/react";

export function App() {
  return (
    <ErrorgapBoundary fallback={<p>Something went wrong.</p>}>
      <Routes />
    </ErrorgapBoundary>
  );
}
```

`ErrorgapBoundary` accepts a `fallback` (node or render function) and an
`onError(error, info)` callback.

## Configuration reference

| Option | Default | Notes |
|---|---|---|
| `endpoint` | (required) | Base URL of your Errorgap instance |
| `projectSlug` | (required) | |
| `projectId` | — | Optional, embedded in payload |
| `apiKey` | — | Sent as `x-errorgap-project-key` |
| `environment` | `"production"` | |
| `release` | — | App version; embedded in payload |
| `sampleRate` | `1.0` | Drop notices client-side at this rate |
| `sourceMaps` | `true` | Resolve frames and source excerpts from deployed source maps |
| `async` | `true` | Fire-and-forget delivery |
| `logger` | `console` | Pass `null` to silence |
| `filterKeys` | `["password", "token", "secret", ...]` | Substring, case-insensitive |
| `captureGlobals` | `true` | Install `error` and `unhandledrejection` listeners |
| `performance` | `false` | `true` or options — see [Performance](#performance) |

For source mapping, deploy the bundle's referenced `.map` file and include
`sourcesContent` in it. The generated script and map must be readable by the
browser; cross-origin assets therefore need suitable CORS headers. Set
`sourceMaps: false` to disable runtime map fetching.

## CORS

The browser sends notices cross-origin, so the Errorgap server must respond
with `Access-Control-Allow-Origin` permitting your site. The SDK sets
`credentials: "omit"` so no cookies cross the boundary.

## Performance

Pass `performance` to measure what pages cost the people using them:

```ts
Errorgap.init({
  endpoint:    "https://errorgap.example.com",
  projectSlug: "your-project",
  apiKey:      "flk_...",
  release:     __APP_VERSION__,
  performance: {
    // Optional: name routes the way your router does. Defaults to
    // location.pathname, which the server templates (`/orders/123` → `/orders/:id`).
    routeName: () => router.currentRoute?.path,
  },
});
```

What is measured, per page load (sampled by `sampleRate`):

| Measurement | What it is |
|---|---|
| Page load | Time to the load event, time to first byte, DOM ready, first contentful paint |
| Core Web Vitals | LCP, INP and CLS (via Google's `web-vitals`), reported when the page is hidden |
| In-app navigations | `pushState`/`popstate` route changes, timed until the next painted frame and until the route's requests finish |
| API calls | Every `fetch` and `XMLHttpRequest`: method, URL (the path for same-origin calls, origin + path otherwise — the query string is never sent), status (0 when no response) and duration |

Timings are batched and sent every 10 seconds, and with `navigator.sendBeacon`
when the page is hidden. They appear under **Performance → Browser**.

| Option | Default | Notes |
|---|---|---|
| `sampleRate` | `1.0` | Share of page loads measured |
| `routeName` | `location.pathname` | Returns the current route template |
| `trackRequests` | `true` | Time fetch and XHR calls |
| `flushIntervalMs` | `10000` | How often batches are sent |
| `tracePropagationTargets` | `[]` | Other origins (prefixes or RegExps) that get the trace header; same-origin calls always do |

Each timed same-origin call carries an `x-errorgap-trace` header. A server
SDK that reads it (Ruby, Laravel, Go, Spring, ASP.NET Core, Node, Python…)
records it on its transaction, and Errorgap links the browser's view of the
call to the server trace that answered it. For an API on another origin, list
it in `tracePropagationTargets` once its CORS policy allows the header:

```ts
performance: { tracePropagationTargets: ["https://api.example.com"] }
```

Requests to the Errorgap endpoint itself and to `ignoreOrigins` prefixes are
not timed. Beacons cannot set headers, so the final batch carries the
project key as an `api_key` query parameter; the key is ingest-only.

## Graceful flush

```ts
await Errorgap.flush();
```

Use this before navigating away or shutting down a single-page app to make
sure queued notices are sent.

## Development

```sh
npm install
npm test
npm run build
```

## License

MIT.
