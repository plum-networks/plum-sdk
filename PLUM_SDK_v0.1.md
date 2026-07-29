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
| `mimeTypes` | | 연결할 파일 타입 목록. 항목은 확장자(`".md"` 또는 `"md"`), 정확한 MIME(`"text/markdown"`), MIME 와일드카드(`"image/*"`) 모두 가능. 선언하면 Drive 의 **"Open with"** 메뉴에 이 앱이 뜨고, 선택 시 파일 핸들과 함께 실행된다 (아래 **Drive 연동 — Open with** 절). |
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
  /** 박스가 협업 릴레이를 제공할 때만 존재. 없으면 앱이 알아서 폴백할 것. */
  collab?: PlumCollab;
}

interface PlumFiles {
  /**
   * 파일 선택 다이얼로그를 띄움.
   * @param opts.accept 확장자(".docx") 또는 MIME 타입. 배열 가능.
   * @param opts.multiple true 면 다중 선택 — 반환이 FileHandle[] 이 됨 (1개 이상).
   * @returns 선택된 핸들(들), 또는 사용자가 취소 시 null.
   */
  openPicker(opts?: { accept?: string | string[]; multiple?: boolean }):
    Promise<FileHandle | FileHandle[] | null>;

  /**
   * Drive "Open with"로 실행됐을 때 넘겨받은 파일 핸들.
   * 직접 실행이거나 핸들이 만료된 경우(stale reload) null.
   */
  launchFile(): Promise<FileHandle | null>;

  /**
   * 핸들의 스트리밍 URL. <video src>/<img src>/Range fetch 에 그대로 사용.
   * 전체 바이트를 메모리에 올리지 않고 재생/부분 로드할 때 쓴다.
   * files:read 권한 필요. 핸들 만료 시 URL 요청이 404 를 반환.
   */
  url(handle: FileHandle): string;

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

interface PlumCollab {
  /** 방에 참여. 이후 그 방의 메시지를 받는다. */
  join(roomId: string): void;
  /** 방에서 나감. 구독도 함께 정리된다. */
  leave(roomId: string): void;
  /** 방의 다른 참여자들에게 전달. 자기 자신에게는 오지 않는다. */
  publish(roomId: string, message: unknown): void;
  /** 구독. 반환값을 호출하면 구독 해제. */
  subscribe(roomId: string, handler: (message: unknown) => void): () => void;
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

## Drive 연동 — Open with

manifest 에 `mimeTypes` 를 선언하면 Drive 파일의 **"Open with"** 메뉴에 앱이 나타난다.
사용자가 선택하면 박스가 그 파일의 핸들을 mint 하고 앱을
`/apps/<id>/?mode=preview&handle=<id>&name=<파일명>` 으로 연다.
앱은 쿼리를 직접 파싱하지 말고 `launchFile()` 로 받는다:

```js
const f = await window.plum.files.launchFile();
if (f) {
  // Drive에서 파일과 함께 실행됨 — 바로 열기
  const bytes = await window.plum.files.readBytes(f);
  render(bytes);
} else {
  // 직접 실행 — 빈 문서/자체 picker 로 시작
}
```

- 매칭 규칙은 서버가 판정한다: `mimeTypes` 항목이 확장자(`.md`/`md`)면 파일 확장자와,
  MIME(`text/markdown`, `image/*`)이면 확장자의 등록 MIME 과 비교.
- 핸들 권한은 picker 와 동일: 읽기는 `files:read`, 저장(덮어쓰기)은 `files:write`.
- docx/csv/xlsx/pptx 는 기본 핸들러가 내장 오피스 앱(Plum Docs/Sheet/Slide)이지만,
  같은 타입을 선언한 서드파티 앱도 Open with 목록에 함께 뜬다.

## 스트리밍 — `url(handle)`

`readBytes` 는 전체 바이트를 메모리에 올린다. 동영상·대용량 파일은 `url()` 로
핸들의 HTTP URL 을 받아 미디어 엘리먼트나 Range fetch 에 넘길 것 (서버가
Range 요청을 지원한다):

```js
const f = await window.plum.files.openPicker({ accept: ['.mp4', '.mov'] });
videoEl.src = window.plum.files.url(f);   // 전체 다운로드 없이 재생·seek
```

주의: URL 의 수명은 핸들 수명과 같다 (아래 절). 페이지 세션을 넘겨 저장하지 말 것.

## 핸들 수명

- `openPicker` / `saveAsPicker` / `launchFile` 이 반환한 핸들은 **현재 페이지 세션 동안** 유효.
- 페이지 reload 후 같은 파일을 다시 다루려면 picker 를 다시 열어야 함 (v0.1 한정).
- 핸들의 `id` 를 localStorage / sessionStorage 에 저장해서 재사용하지 말 것 (서버 측 만료될 수 있음).

## plum.collab — 실시간 협업 (권한 불필요)

같은 문서를 연 앱 인스턴스끼리 실시간으로 주고받는 통로. 앱은 자기 소켓을 열지
않는다 — 방에 `join` 해서 `publish` / `subscribe` 하면 박스가 같은 방의 다른
인스턴스로 그대로 전달한다. **박스는 내용을 해석하지도, 저장하지도 않는다.**
무엇을 보낼지(문서 스냅샷, 커서, presence)는 전적으로 앱이 정한다.

| API | 설명 |
|---|---|
| `plum.collab.join(room)` | 방 참여. 끊겨도 SDK 가 재접속하면서 자동으로 다시 참여한다. |
| `plum.collab.leave(room)` | 방 나가기. |
| `plum.collab.publish(room, msg)` | 같은 방의 **다른** 인스턴스에 전달(자기 echo 없음). |
| `plum.collab.subscribe(room, fn)` | 구독. 반환된 함수를 호출하면 해제. |

```js
const room = 'name:' + fileName;
window.plum.collab.join(room);
const off = window.plum.collab.subscribe(room, (msg) => applyRemote(msg));
window.plum.collab.publish(room, { t: 'doc', html: editor.getHTML() });
```

**있는지 먼저 확인할 것.** 구버전 박스에는 `collab` 이 없다:

```js
const collab = window.plum?.collab;
if (collab) { /* 릴레이 사용 */ } else { /* 앱 나름의 폴백 */ }
```

### 방 이름과 보이는 범위 ⚠️

방은 `(앱 id, 방 이름)` 으로 갈린다. 다른 앱의 방에는 절대 닿지 않는다.
다만 **같은 박스의 구성원끼리는 방 이름이 공용 이름 공간**이다 — 그래야 다른
사람과 같은 문서에서 만날 수 있기 때문이다. 아무나 보면 안 되는 것을 방에
흘리지 말 것. 대신 참여자는 숨을 수 없다: 박스는 방의 참여자를 셸(앱 프레임
위 신원 스트립)에 이름으로 표시하므로, 듣고만 있어도 상대에게 보인다.

제한: 메시지 4 MB, 소켓당 방 16개. 히스토리는 없다(참여 이전 메시지는 못 받는다).

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
