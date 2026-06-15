# @errorgap/browser

Browser notifier for [Errorgap](https://errorgap.com). Captures uncaught
errors and unhandled promise rejections, parses cross-browser stack traces,
and ships notices to an Errorgap server. Includes an opt-in React error
boundary.

Source maps are out of scope for v1 — the SDK ships raw stack traces; map
them server-side or via a follow-up release.

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
| `async` | `true` | Fire-and-forget delivery |
| `logger` | `console` | Pass `null` to silence |
| `filterKeys` | `["password", "token", "secret", ...]` | Substring, case-insensitive |
| `captureGlobals` | `true` | Install `error` and `unhandledrejection` listeners |

## CORS

The browser sends notices cross-origin, so the Errorgap server must respond
with `Access-Control-Allow-Origin` permitting your site. The SDK sets
`credentials: "omit"` so no cookies cross the boundary.

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
