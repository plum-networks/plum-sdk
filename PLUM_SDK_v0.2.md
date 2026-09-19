# Plum SDK — v0.2

**Status**: draft, 2026-09-19 (plan T4c). v0.1(`PLUM_SDK_v0.1.md`)은 **동결** — 여기에는 추가만 있다.
v0.1 로 만든 앱은 손대지 않아도 그대로 돈다.

호스트 API 레벨은 **1 그대로**다 — `compat.yaml` 의 규칙대로 `api_level` 은 무언가가 *없어지거나 뜻이 바뀔 때만* 올린다
(추가는 올리지 않는다; 앱이 이유 없이 늙는다). v0.2 는 전부 추가이므로 앱은 **존재 여부로** 분기한다:
`typeof plum.ui !== 'undefined'`, `plum.app.capabilities ? await plum.app.capabilities() : null`. 런타임 파일은 그대로
`/apps/runtime/plum-sdk.js` 한 줄이다.

## 새 네임스페이스·메서드 요약

| API | 권한 | 무엇 |
|---|---|---|
| `plum.ui.share({text?, url?, handles?})` | 핸들 공유 시 `files:read` | 시스템 공유 시트. 폰 앱 안에선 네이티브(브리지), 브라우저에선 Web Share, 둘 다 없으면 `UnsupportedError` |
| `plum.ui.clipboard.write(text)` / `.read()` | — | 클립보드. 폴백 `navigator.clipboard` |
| `plum.ui.capture({mode})` | `files:write` | 카메라로 사진/영상 → **FileHandle** (Drive `Camera/` 에 저장됨). 폴백 `<input type=file capture>` + `saveAsPicker` |
| `plum.ui.haptic(style)` | — | 햅틱. 폴백 `navigator.vibrate`, 없으면 무시 |
| `plum.ui.openExternal(url)` | — | `http(s)` 를 시스템 브라우저로. 폴백 `window.open(url, "_blank", "noopener")` |
| `plum.ui.biometric.confirm(reason)` | — | Face ID/지문 확인. 브라우저에선 `UnsupportedError` |
| `plum.ui.nav.setBackHandler(fn \| null)` | — | 뒤로가기를 앱이 받는다. 브라우저 셸에선 `history` 와 무관하게 no-op 이며 `false` 반환 |
| `plum.ui.nav.close()` | — | 앱 화면 닫기(폰 앱) / 셸에 닫기 요청(웹, postMessage `close`) |
| `plum.app.capabilities()` | — | `{ sdk: "0.2", apiLevel, native: { platform, version, capabilities[] } \| null, ui: { share, clipboard, capture, haptic, biometric, nav } }` — 각 ui 값은 `"native" \| "web" \| "none"` |
| `plum.app.open(appId, path?)` | — | 다른 앱으로 이동(셸에 요청). 폰 앱은 그 앱의 WebView 로 교체, 웹은 런치패드 라우팅. 설치 안 됐으면 스토어 페이지로 |
| `plum.events.subscribe(kinds, cb)` | — | v0.1 이후 core 에 먼저 들어간 것을 문서화(§이벤트) |
| `plum.entitlement.get()` | — | 이 앱의 스토어 영수증 뷰 `{ skus:[{sku, kind, expires_at, active}], refreshed_at, stale }` |
| `plum.entitlement.refresh()` | — | 박스에 지금 영수증을 다시 받아오게 한다(구매 직후) |
| `plum.photos.pick({multiple?})` | `files:read` | 사진 라이브러리 피커(피커의 사진 탭 승격) → FileHandle 또는 FileHandle[] |
| `plum.app.theme()` / `onThemeChange(fn)` / `locale()` / `onLocaleChange(fn)` / `setDocumentState()` | — | v0.1 이후 core 에 들어간 것을 문서화 |

새 오류 클래스: `UnsupportedError`(이 호스트엔 그 능력이 없음), `CancelledError`(사용자가 시트·촬영·인증을 취소).
둘 다 `code` 필드(`'UnsupportedError'`, `'CancelledError'`). 기존 4종(`PermissionDeniedError`,
`FileNotFoundError`, `QuotaExceededError`, `NetworkError`)은 그대로.

## TypeScript 타입 (추가분)

```ts
interface PlumSDK {
  files: PlumFiles; user: PlumUser; app: PlumApp; service: PlumService; events: PlumEvents;
  collab?: PlumCollab;
  ui: PlumUI;                 // v0.2
  entitlement: PlumEntitlement; // v0.2
  photos: PlumPhotos;         // v0.2
}

type UISource = "native" | "web" | "none";

interface PlumUI {
  share(opts: { text?: string; url?: string; handles?: FileHandle[] }): Promise<void>;
  clipboard: { write(text: string): Promise<void>; read(): Promise<string> };
  capture(opts: { mode: "photo" | "video" }): Promise<FileHandle>;
  haptic(style: "light" | "medium" | "heavy" | "success" | "warning" | "error"): Promise<void>;
  openExternal(url: string): Promise<void>;
  biometric: { confirm(reason: string): Promise<void> };
  nav: {
    /** 반환값: 이 호스트가 뒤로가기를 앱에 넘길 수 있는가. */
    setBackHandler(fn: (() => void) | null): boolean;
    close(): void;
  };
}

interface PlumEntitlement {
  get(): Promise<{
    skus: { sku: string; kind: string; expires_at: string; active: boolean }[];
    refreshed_at: string;   // "" = 한 번도 못 받음
    stale: boolean;         // 48h 이상 갱신 실패
  }>;
  refresh(): Promise<number>; // 박스가 지금 보유한 영수증 수
}

interface PlumPhotos {
  pick(opts?: { multiple?: boolean }): Promise<FileHandle | FileHandle[] | null>;
}

interface PlumApp {
  host(): Promise<{ deviceName: string; coreVersion: string; osVersion: string; apiLevel: number }>;
  capabilities(): Promise<{
    sdk: "0.2";
    apiLevel: number;   // compat.yaml 의 api_level (지금 1)
    native: { platform: string; version: number; capabilities: string[] } | null;
    ui: { share: UISource; clipboard: UISource; capture: UISource; haptic: UISource; biometric: UISource; nav: UISource };
  }>;
  open(appId: string, path?: string): Promise<void>;
  theme(): "light" | "dark";
  onThemeChange(fn: (t: "light" | "dark") => void): () => void;
  locale(): string;
  onLocaleChange(fn: (l: string) => void): () => void;
  setDocumentState(info: { name?: string; state?: "saved" | "editing" | "saving" | string }): void;
}

interface PlumEvents {
  /** kinds: 'drive' | 'photos' | 'notification' | 'apps:<id>' | 'apps:*' … 비우면 전부. 반환값으로 해제. */
  subscribe(kinds: string | string[], cb: (ev: { id?: string; kind: string; at?: string; payload?: unknown }) => void): () => void;
}
```

## 사용 예 — 공유와 카메라

```js
const caps = await plum.app.capabilities();
if (caps.ui.capture !== "none") {
  const photo = await plum.ui.capture({ mode: "photo" });   // FileHandle (Drive/Camera/…)
  const bytes = await plum.files.readBytes(photo);
  await plum.ui.share({ text: "오늘 사진", handles: [photo] });
}
```

## 사용 예 — 유료 기능 잠금

```js
const ent = await plum.entitlement.get();
const pro = ent.skus.some((s) => s.sku === "pro" && s.active);
if (!pro) showUpsell();            // 결제는 스토어(웹·박스 UI)에서 — 앱 안 결제 유도 금지(플랫폼 규칙)
if (ent.stale) showOfflineNotice(); // 48h 넘게 영수증 갱신 실패
```

박스는 같은 정보를 앱의 서버 .plu 에도 준다: 프록시 헤더 `X-Plum-Entitlements: pro,plus`
(`X-Plum-Entitlements-Stale: 1`), 컨트롤 소켓 `GET /entitlement`. **무엇을 잠글지는 앱이 정하고 박스는 영수증만
증명한다.**

## 사용 예 — 뒤로가기

```js
const native = plum.ui.nav.setBackHandler(() => {
  if (editor.hasUnsaved()) askDiscard(); else plum.ui.nav.close();
});
// native === false 인 브라우저 셸에서는 그냥 브라우저 뒤로가기가 동작한다.
```

## 이벤트 채널 (`plum.events`, api level 1 부터 있음)

`GET /api/events`(Server-Sent Events) 구독. `kinds` 는 `drive`·`photos`·`notification`·`apps:<id>`·`apps:*`,
비우면 전부. 콜백은 `{id, kind, at, payload}` 를 받고 박스가 `reset` 을 보내면 `kind:'reset'` 으로 한 번 불린다(놓친
게 많으니 다시 읽으라는 뜻). 개발자 빌드(prelude `dev:true`)는 `apps:<id>` 의 `{type:'installed'}` 를 받아 스스로
새로고침한다.

## 폰 앱 안에서 (네이티브 브리지)

`plum.ui.*` 는 Plum 앱의 WebView 안에서 `PLUM_NATIVE_BRIDGE_v1.md` 로 네이티브를 부른다. 앱은 브리지를 직접 만지지
않는다. 브리지가 없는 호스트(브라우저·구버전 앱)에서는 표 아래의 폴백이 쓰이며, 폴백조차 없는 것(생체 인증)은
`UnsupportedError` 를 던진다 — `plum.app.capabilities()` 로 먼저 확인하는 것이 예의다.

## v0.2 에서 안 하는 것

- 푸시 구독(`push.subscribe`)은 T6 푸시 게이트웨이 뒤에 `plum.ui.push` 로 온다(브리지 v1 에는 자리만 있고 항상 `unsupported`).
- 앱 간 데이터 전달(intent 페이로드) — `plum.app.open(appId, path)` 의 path 로만.
- 백그라운드 가져오기·서비스 워커 캐시 — 셸이 `no-store` 인 개발자 빌드와 5분 캐시인 스토어 빌드를 구분하는 현행 유지.
