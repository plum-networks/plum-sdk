# Plum Native Bridge — v1

**Status**: draft, 2026-09-19 (plan T4b). 대상: Plum 모바일 앱의 앱 WebView(`AppWebViewScreen`, iOS/Android)와
그 안에서 도는 패널(.plu)의 SDK 런타임(`/apps/runtime/plum-sdk.js`).

패널이 네이티브 능력(공유 시트·클립보드·카메라·햅틱·생체 인증·뒤로가기·외부 링크)을 쓰는 단 하나의 통로다.
패널은 이 브리지를 **직접 부르지 않는다** — `window.plum.ui.*`(SDK v0.2)를 부르고, SDK 가 브리지가 있으면
네이티브로, 없으면 웹 표준(Web Share·Clipboard·`<input capture>`)으로 폴백한다. 그래서 같은 .plu 가 박스 웹
셸(브라우저)과 폰 앱 안에서 똑같이 돈다.

## 1. 채널

| 방향 | 형태 | iOS | Android |
|---|---|---|---|
| 페이지 → 네이티브 | `window.plumNative.postMessage(<JSON 문자열>)` | `WKUserContentController.add(handler, name: "plumNative")` + 문서 시작 스크립트가 `window.plumNative = { postMessage: s => webkit.messageHandlers.plumNative.postMessage(s) }` 를 정의 | `addJavascriptInterface(PlumNativeBridge, "plumNative")`, `@JavascriptInterface fun postMessage(json: String)` |
| 네이티브 → 페이지 (응답) | `window.__plumNativeReply(id, result)` | `evaluateJavaScript` | `evaluateJavascript` |
| 네이티브 → 페이지 (이벤트) | `window.__plumNativeEvent(name, payload)` | 〃 | 〃 |
| 능력 광고 | `window.__PLUM_NATIVE__ = { version: 1, platform, capabilities: [...] }` — **페이지 스크립트보다 먼저** 정의 | `WKUserScript(injectionTime: .atDocumentStart, forMainFrameOnly: true)` | `WebViewCompat.addDocumentStartJavaScript`(androidx.webkit); 없으면 `plumNative.info()`(동기, JSON 문자열)를 SDK 가 호출 |

요청 메시지:

```json
{ "id": "r-17", "method": "share", "params": { "text": "…" } }
```

응답(둘 중 하나):

```json
{ "ok": true,  "result": { … } }
{ "ok": false, "error": { "code": "cancelled", "message": "user dismissed the sheet" } }
```

- `id` 는 페이지가 만든 문자열, 요청당 유일. 응답은 **정확히 한 번** 온다. 네이티브는 처리 못 하는 method 에도
  `unsupported` 로 반드시 응답한다 — 응답 없는 요청은 페이지에서 30초 뒤 `timeout` 으로 거절된다.
- 메인 프레임에만 브리지를 노출한다(`forMainFrameOnly`). 서브프레임(iframe) 은 브리지를 받지 못한다.
- 페이지는 같은 origin(박스) 만 로드된다. 외부 origin 으로 navigate 하면 브리지는 사라지고(§4) 그 페이지는
  시스템 브라우저로 넘긴다.
- 모든 문자열은 UTF-8, params/result 는 JSON 으로 직렬화 가능한 값만. 바이너리는 절대 브리지로 보내지 않는다 —
  파일은 **핸들**(`{id, name}`, SDK v0.1 `FileHandle`)로 주고받고 바이트는 박스 API 가 나른다.

## 2. 능력(capabilities)

`__PLUM_NATIVE__.capabilities` 에 실린 이름만 부를 수 있다. v1 이름:

| capability | method | params | result | 오류 |
|---|---|---|---|---|
| `share` | `share` | `{ text?, url?, handles?: FileHandle[] }` 최소 하나 | `{}` | `cancelled`, `failed` |
| `clipboard` | `clipboard.write` | `{ text }` | `{}` | `failed` |
| 〃 | `clipboard.read` | `{}` | `{ text }` | `denied`(OS 가 막음), `failed` |
| `capture` | `capture` | `{ mode: "photo" \| "video" }` | `{ handle: FileHandle }` | `cancelled`, `denied`(카메라 권한), `failed` |
| `haptic` | `haptic` | `{ style: "light" \| "medium" \| "heavy" \| "success" \| "warning" \| "error" }` | `{}` | — (없는 기기는 조용히 `{}`) |
| `openExternal` | `openExternal` | `{ url }` (`http(s)://` 만) | `{}` | `invalid_params`, `failed` |
| `biometric` | `biometric.confirm` | `{ reason }` | `{ ok: true }` | `cancelled`, `unavailable`(등록 안 됨/미지원), `failed` |
| `nav` | `nav.setBackHandler` | `{ enabled }` | `{}` | — |
| 〃 | `nav.close` | `{}` | `{}` | — |
| 〃 | `nav.openApp` | `{ app_id, path? }` | `{}` | `failed` (설치 안 됐으면 셸이 스토어 페이지를 연다) |
| `push` | `push.subscribe` | `{ topics: string[] }` | `{ subscribed: string[] }` | `unsupported` (**T6 전까지 항상**) |

공통 오류 코드: `unsupported`(이 셸엔 없는 능력), `invalid_params`, `cancelled`, `denied`, `unavailable`,
`timeout`(페이지 쪽), `failed`. 메시지는 사람이 읽는 영어 한 줄.

### share
- `handles` 가 있으면 셸이 `GET /api/apps/handle/<id>/read` 로 바이트를 받아(세션 쿠키·앱 토큰은 셸이 이미
  갖고 있다) 임시 파일로 두고 시스템 공유 시트에 넣는다. 핸들 권한은 SDK 와 같다(`files:read`).
- `text` 와 `url` 만 있으면 텍스트 공유. 시트가 닫히면 `{}` — 사용자가 어디로 보냈는지는 알려주지 않는다.

### capture
- 셸이 시스템 카메라를 연다. 결과는 사용자의 Drive `Camera/` 폴더에 업로드한 뒤(셸의 기존 업로드 경로)
  `POST /api/apps/picker/grant` 로 그 앱에 핸들을 발급해 돌려준다. 앱은 이후 `plum.files.readBytes(handle)`.
- 왜 핸들인가: 사진 한 장이 10 MB 를 넘고 브리지는 문자열 채널이다. 바이트를 JS 로 옮기지 않는다.
- 카메라 권한 거부 → `denied`. 사용자가 촬영 취소 → `cancelled`.

### nav
- `nav.setBackHandler({enabled:true})` 뒤에는 시스템 뒤로가기(제스처·버튼·헤더 ✕ 는 제외)가 화면을 닫는 대신
  `back` 이벤트를 페이지에 준다. 페이지가 처리 못 하면 `nav.close()` 로 닫는다. 페이지가 사라지면(navigate,
  reload) 핸들러는 자동 해제된다.
- 헤더의 ✕ 는 언제나 셸의 것이다 — 앱이 사용자를 가둘 수 없다.

### openExternal
- `http`/`https` 만. 그 외 스킴(`tel:`, `mailto:`, 커스텀)은 `invalid_params`. 시스템 브라우저(Custom Tabs /
  `SFSafariViewController` 또는 `openURL`)로 연다. 페이지 안 `<a target=_blank>` 와 외부 origin 링크도 같은 길로
  간다(§4).

## 3. 이벤트 (네이티브 → 페이지)

| name | payload | 언제 |
|---|---|---|
| `back` | `{}` | `nav.setBackHandler` 가 켜진 상태에서 뒤로가기 |
| `theme` | `{ theme: "light" \| "dark" }` | 시스템/앱 테마 변경 (SDK 의 `app.onThemeChange` 로 흘러간다; 실행 URL 의 `?theme=` 이 첫 값) |
| `locale` | `{ locale: "ko" }` | 앱 언어 변경 |
| `resume` / `pause` | `{}` | 앱이 전면으로 돌아옴 / 뒤로 감. 패널은 `resume` 에 목록을 다시 읽는 식으로 쓴다 |

## 4. 셸이 함께 책임지는 것 (브리지 밖)

이것들은 method 가 아니라 WebView 설정이다. 둘 다 v1 에 포함.

| 항목 | iOS | Android |
|---|---|---|
| `<input type=file>` | WKWebView 기본 문서 피커 | `WebChromeClient.onShowFileChooser` (있음) |
| JS `alert/confirm/prompt` | `WKUIDelegate` 3종 → 네이티브 알림 | `onJsAlert/onJsConfirm/onJsPrompt` → 네이티브 다이얼로그 |
| 외부 링크 | `decidePolicyFor navigationAction`: 박스 origin 밖·`target=_blank` → `openExternal` 경로, 취소 | `shouldOverrideUrlLoading` 동일 규칙 |
| 다운로드 | `WKDownloadDelegate` → 파일 앱 저장 시트 | `setDownloadListener` → `DownloadManager` (쿠키 동봉) |
| 카메라·마이크 권한(`getUserMedia`) | `WKUIDelegate.requestMediaCapturePermissionFor` — 앱이 `capture` 능력을 쓰도록 유도하고 v1 은 거부 | `onPermissionRequest` — v1 은 거부 |
| 뷰포트·테마 | 기존 `?lang=&theme=` (T4a) | 〃 |

## 5. 보안 규칙

1. 브리지는 **박스 origin 의 메인 프레임에만** 있다. 셸은 요청마다 `webView.url` 의 origin 이 박스 도메인인지
   확인하고 아니면 `denied` 로 응답한다(`WKScriptMessage.frameInfo.isMainFrame`·`securityOrigin`, Android 는
   `WebView.url` 검사).
2. 앱 신원은 브리지가 정하지 않는다. 핸들·업로드·grant 는 전부 박스 API 가 세션과 앱 토큰으로 판정한다. 브리지는
   "이 화면에 떠 있는 앱" 이상을 알 필요가 없다.
3. 파일 바이트는 브리지를 지나지 않는다(핸들만).
4. `openExternal` 은 `http(s)` 만, `capture` 결과는 사용자 Drive 에 남는다(앱 비밀 폴더가 아니다).
5. 셸이 지원하지 않는 method 는 `unsupported` — 절대 조용히 삼키지 않는다.

## 6. SDK 쪽 (`plum-sdk.js`, v0.2)

```js
// 내부 — 앱은 쓰지 않는다
native.available()                 // __PLUM_NATIVE__ 가 있고 plumNative.postMessage 가 함수인가
native.has('share')                // capability 포함 여부
native.call('share', params)       // Promise, 30s timeout, 응답 1회
native.on('back', fn)              // __plumNativeEvent 디스패치
```

`window.__plumNativeReply` / `window.__plumNativeEvent` 는 SDK 가 정의한다. 셸은 SDK 가 아직 로드되지 않은 순간에
이벤트를 보내지 않는다(문서 로드 완료 뒤에만).

## 7. 구현 체크리스트

- Android `AppWebViewScreen.kt`: `PlumNativeBridge`(`@JavascriptInterface postMessage/info`), 응답은 메인
  스레드 `evaluateJavascript`, `onJsAlert/Confirm/Prompt`, `shouldOverrideUrlLoading`, `setDownloadListener`,
  `onPermissionRequest`, `BackHandler` 가 `nav` 상태를 본다, 카메라는 `ActivityResultContracts.TakePicture`
  + 업로드 + grant, 공유는 `Intent.ACTION_SEND(_MULTIPLE)` + `FileProvider`.
- iOS `AppWebViewScreen.swift`: `WKUserContentController` 핸들러 + 문서 시작 `WKUserScript`, `WKUIDelegate`
  (JS 다이얼로그·미디어 권한), `decidePolicyFor navigationAction`, `WKDownloadDelegate`, `UIActivityViewController`,
  `UIImagePickerController`(camera), `LAContext`, `UINotificationFeedbackGenerator`/`UIImpactFeedbackGenerator`,
  `SFSafariViewController`.
- 웹 런타임: `plum.ui.*` + 폴백, `plum.app.capabilities()`.
- 검증: 헤드리스 브라우저로 폴백 경로, 실기기로 share/clipboard/capture/haptic/biometric/back/external.
