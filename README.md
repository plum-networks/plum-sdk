# Plum SDK

Browser-side JavaScript library that lets `.plu` apps talk to a host
**Plum Box** (`plum-box-core`) — file open/save, current user info, host metadata.

The SDK is **not bundled into apps**; the host serves it at a fixed path
(`/apps/runtime/plum-sdk.js`) so every app on a given device shares one
script tag and stays in sync with the device's API version.

## Repo contents

| File | Purpose |
|---|---|
| `PLUM_SDK_v0.1.md` | API specification (TypeScript-style types + semantics). Source of truth. |
| `src/plum-sdk-mock.js` | Drop-in stub for offline development. Same API surface, file pickers go through `<input type=file>`, writes trigger browser downloads. App authors copy this into their repo's `vendor/` directory until the real SDK is published. |
| `src/plum-sdk.ts` | (planned) Real implementation. Talks to `plum-box-core` over `fetch`. |

## Status

- v0.1 spec frozen
- mock SDK: usable
- real SDK: not yet implemented (use mock for development)

## License

MIT — apps consume this as a host-provided runtime.
