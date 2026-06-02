# Plum SDK — v0.1

**Status**: draft, 2026-05-10

앱이 host plum-box-core 와 대화하는 인터페이스. 동일 origin 의 정적 JS 로 배포되며, 앱은 `<script>` 한 줄로 import.

## 로딩

```html
<script src="/apps/runtime/plum-sdk.js"></script>
<script>
  // window.plum 으로 바로 접근
  const me = await window.plum.user.current();
</script>
```

개발 단계에선 동봉된 `plum-sdk-mock.js` 를 같은 자리에 로드하면 동일한 API 로 동작 (자세한 건 mock 파일 헤더 참조).

## manifest.json

`.plu` 루트의 `manifest.json` 이 앱 메타데이터를 선언한다.

```json
{
  "id": "im.plum.word",
  "name": "Plum Word",
  "version": "0.1.0",
  "entry": "index.html",
  "icon": "icon.png",
  "description": "Open and edit .docx files",
  "mimeTypes": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  "permissions": ["files:read", "files:write", "user:profile"],
  "mobile": true
}
```

| 필드 | 필수 | 설명 |
|------|------|------|
| `id` | ✅ | DNS-friendly 역도메인 (`^[a-z0-9][a-z0-9._-]{0,127}$`) |
| `name` | ✅ | 표시 이름 |
| `version` | ✅ | semver |
| `entry` | | 진입 HTML (기본 `index.html`) |
| `icon` | | 아이콘 상대경로 |
| `description` | | 설명 |
| `mimeTypes` | | 연결할 MIME 목록 |
| `permissions` | | `files:read` / `files:write` / `user:profile` / `service:call` 중에서만 |
| `mobile` | | **(boolean, 기본 `false`)** `true` 일 때만 Plum 모바일 앱의 **"앱"(Launchpad) 탭**에 표시되고, 탭하면 풀스크린 WebView 로 열린다. 데스크톱 포인터/큰 뷰포트를 가정하는 앱은 미설정(=false)으로 둘 것. |
| `server` | | **(object, 선택)** 앱이 ship 하는 박스측 서비스 = "server .plu". `{ "bin": "<번들 상대경로>", "args"?: [...], "healthPath"?: "/healthz" }`. 없으면 front-end-only(기존 모델, 그대로). 자세히는 아래 **서버 .plu** 절. |

## TypeScript 타입

```ts
declare global {
  interface Window {
    plum: PlumSDK;
  }
}

interface PlumSDK {
  files: PlumFiles;
  user: PlumUser;
  app: PlumApp;
}

interface PlumFiles {
  /**
   * 파일 선택 다이얼로그를 띄움.
   * @param opts.accept 확장자(".docx") 또는 MIME 타입. 배열 가능.
   * @returns 선택된 핸들, 또는 사용자가 취소 시 null.
   */
  openPicker(opts?: { accept?: string | string[] }): Promise<FileHandle | null>;

  /**
   * 새 파일 저장 다이얼로그.
   * @param opts.defaultName 기본 파일명 (확장자 포함 권장).
   * @returns 새 파일 핸들 (실제 쓰기는 writeBytes 호출 시), 또는 취소 시 null.
   */
  saveAsPicker(opts: { defaultName: string }): Promise<FileHandle | null>;

  /** 핸들의 바이트 읽기. files:read 권한 필요. */
  readBytes(handle: FileHandle): Promise<Uint8Array>;

  /** 덮어쓰기. 새 핸들이면 새 파일 생성. files:write 권한 필요. */
  writeBytes(handle: FileHandle, bytes: Uint8Array): Promise<void>;

  /** 메타데이터만. */
  stat(handle: FileHandle): Promise<{ name: string; size: number; mtime: number }>;
}

interface PlumUser {
  /**
   * 현재 로그인 사용자.
   * user:profile 권한 필요. 권한 없으면 PermissionDeniedError.
   */
  current(): Promise<{
    id: string;
    username: string;
    email: string;
    displayName: string;
  }>;
}

interface PlumApp {
  /** 호스트 plum-box 의 디바이스 정보. 권한 불필요. */
  host(): Promise<{ deviceName: string; coreVersion: string }>;
}

interface FileHandle {
  /** 불투명 식별자. 앱은 디코드/파싱하지 말 것. */
  id: string;
  /** UI 표시용 파일명. */
  name: string;
}
```

## 에러 클래스

| 에러                       | 발생 조건 |
|---------------------------|-----------|
| `PermissionDeniedError`   | manifest 에 선언 안 한 권한 호출 |
| `FileNotFoundError`       | 핸들이 만료됐거나 파일이 삭제됨 |
| `QuotaExceededError`      | 사용자 quota 초과 (write 시) |
| `NetworkError`            | plum-box 응답 실패 (드물지만 가능) |

모두 `Error` 상속, 에러 객체에 `code: string` 필드 있음.

## 사용 예 — Open / Edit / Save 라운드트립

```js
const f = await window.plum.files.openPicker({ accept: '.docx' });
if (!f) return;

const bytes = await window.plum.files.readBytes(f);
const edited = editDocxInBrowser(bytes);   // 앱 자체 로직

await window.plum.files.writeBytes(f, edited);
```

## 사용 예 — Save As (새 파일)

```js
const f = await window.plum.files.saveAsPicker({ defaultName: 'untitled.docx' });
if (!f) return;
await window.plum.files.writeBytes(f, generatedDocxBytes);
```

## 핸들 수명

- `openPicker` / `saveAsPicker` 가 반환한 핸들은 **현재 페이지 세션 동안** 유효.
- 페이지 reload 후 같은 파일을 다시 다루려면 picker 를 다시 열어야 함 (v0.1 한정).
- 핸들의 `id` 를 localStorage / sessionStorage 에 저장해서 재사용하지 말 것 (서버 측 만료될 수 있음).

## plum.service — 앱 자체 백엔드 호출 (`service:call`)

앱이 박스측 서비스(server .plu)를 ship 하면, 그 앱의 web UI 는 `window.plum.service`
로 자기 백엔드를 호출한다. 코어가 검증된 신원을 헤더로 주입하므로 백엔드는 호출자를
신뢰할 수 있다.

| 메서드 | 설명 |
|---|---|
| `plum.service.fetch(path, init?)` | 자기 server .plu 를 `/apps/<id>/svc/<path>` 로 호출. `fetch` 와 동일한 `Response` 반환(`.json()`/`.blob()`/streaming 자유). 박스 세션으로 인증됨. |
| `plum.service.url(path)` | svc 절대경로 문자열 (`<img src>`, `EventSource`, streaming fetch 등). |

```ts
const res = await window.plum.service.fetch('/list');
const items = await res.json();
```

`service:call` 권한 필요. front-end-only 앱(`manifest.server` 없음)은 호출 대상이 없어 무의미.

## 서버 .plu — 박스측 서비스 (server-side SDK)

`manifest.server` 를 선언하면 앱은 박스에서 도는 자기 서비스를 ship 한다. 코어가
(user, app) 당 한 프로세스를 supervise 하고 그 앱 계정으로 uid-drop 해서 실행한다.

**서비스가 받는 환경변수**

| 변수 | 의미 |
|---|---|
| `PLUM_APP_SOCKET` | web UI 요청을 받을 unix 소켓. 여기서 HTTP listen (= `plum.service.fetch` 의 대상). |
| `PLUM_CTL_SOCKET` | 코어 capability 를 호출할 control 소켓 (서버측 SDK transport). |
| `PLUM_APP_DATA_DIR` | 앱 전용 쓰기 가능 디렉토리 (영속, 업그레이드에도 보존). cwd + `HOME`. |
| `PLUM_USER_ID` / `PLUM_APP_ID` / `PLUM_APP_VERSION` | 실행 컨텍스트. |

**프록시가 web UI 요청에 주입하는 헤더(위조 불가):** `X-Plum-User-Id`, `X-Plum-Username`,
`X-Plum-App-Id`, `X-Plum-Perms`. inbound 의 동일 헤더 + `Cookie` 는 코어가 전부 제거한 뒤 설정한다.

**서버측 SDK (`plumsvc`, Go):** `PLUM_CTL_SOCKET` 를 감싸 코어 capability 를 제공.

```go
svc, _ := plumsvc.New()
// 앱 data dir 의 완성 파일을 사용자 스토리지로 이동 (rename = 즉시·GB-safe). files:write 필요.
svc.Publish(plumsvc.Downloads, "staging/<id>/file.iso", "file.iso")        // → 사용자 Downloads
svc.Publish(plumsvc.Files,     "out/report.pdf",        "Reports/report.pdf") // → 사용자 Files
```

**규칙**

- 큰 파일은 `PLUM_APP_DATA_DIR` 에 받은 뒤 `Publish` 로 사용자 스토리지에 넘긴다 (브라우저 경유 ❌).
- `bin` 은 번들 안 상대경로 실행 파일. 현재 **first-party 전용**(서명 검증 전까지) — arm64 ELF.
- `healthPath`(기본 `/healthz`)가 `<500` 을 반환하면 ready 로 표시.
- `plumsvc` 는 지금 다운로더에 동봉돼 있으나, 추후 서드파티용 공유 모듈로 분리 예정.

## v0.1 에서 안 하는 것

- 디렉토리 트리 listing (앱이 사용자 drive 를 자유롭게 탐색하는 API)
- watch / change notification
- 부분 read/write (전체 바이트만)
- 동시 편집 lock
- 외부 앱 간 통신 (intent / share)
