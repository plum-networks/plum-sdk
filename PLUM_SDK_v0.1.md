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

## v0.1 에서 안 하는 것

- 디렉토리 트리 listing (앱이 사용자 drive 를 자유롭게 탐색하는 API)
- watch / change notification
- 부분 read/write (전체 바이트만)
- 동시 편집 lock
- 외부 앱 간 통신 (intent / share)
