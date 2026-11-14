import { describe, expect, it } from 'vitest';
import { errorFromBody } from '../src/api.js';
import { errorHint } from '../src/cli.js';

describe('errors from the box and the store', () => {
  it('reads the box shape', () => {
    expect(errorFromBody(403, 'Forbidden', { error: 'publisher_untrusted', message: 'publisher pub-x is not in this box\'s trust list' })).toMatchObject({
      code: 'publisher_untrusted', message: 'publisher pub-x is not in this box\'s trust list', origin: 'box',
    });
  });
  it('reads the store shape {"detail": {"error", "detail"}}', () => {
    const e = errorFromBody(403, 'Forbidden', { detail: { error: 'namespace_required', detail: 'dev.x.app is not under a namespace you own' } }, 'store');
    expect(e).toMatchObject({ status: 403, code: 'namespace_required', message: 'dev.x.app is not under a namespace you own', origin: 'store' });
    expect(errorHint(e)).toContain('plum-dev whoami');
  });
  it('reads FastAPI\'s own {"detail": "text"} and validation lists', () => {
    expect(errorFromBody(401, 'Unauthorized', { detail: 'publisher token unknown or revoked' }, 'store')).toMatchObject({ code: 'http_401', message: 'publisher token unknown or revoked' });
    expect(errorFromBody(422, 'Unprocessable Entity', { detail: [{ loc: ['body', 'channel'], msg: 'field required' }] }, 'store')).toMatchObject({
      code: 'invalid_request', message: 'channel: field required',
    });
  });
  it('keeps the status line when the body is not JSON', () => {
    expect(errorFromBody(502, 'Bad Gateway', undefined)).toMatchObject({ code: 'http_502', message: 'Bad Gateway' });
  });
  it('gives the next step for the errors a first app meets', () => {
    expect(errorHint(errorFromBody(400, '', { detail: { error: 'icon_required' } }, 'store'))).toContain('--icon');
    expect(errorHint(errorFromBody(409, '', { detail: { error: 'version_not_increasing' } }, 'store'))).toContain('"version"');
    expect(errorHint(errorFromBody(401, '', { detail: 'nope' }, 'store'))).toContain('developer.plum.im/tokens');
    expect(errorHint(errorFromBody(500, '', {}))).toBeUndefined();
  });
});
