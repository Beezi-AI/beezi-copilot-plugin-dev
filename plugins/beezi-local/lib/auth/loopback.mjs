import http from 'http';
import { UserError } from '../core/errors.mjs';
import { callbackOutcome, CALLBACK_OUTCOMES } from './callback.mjs';

const CLOSE_PAGE = '<!doctype html><meta charset="utf-8"><title>Beezi</title>'
  + '<body style="font-family:sans-serif;padding:3rem;text-align:center">'
  + '<h2>✓ Beezi linked</h2><p>You can close this tab and return to the terminal.</p>';
const FAIL_PAGE = '<!doctype html><meta charset="utf-8"><title>Beezi</title>'
  + '<body style="font-family:sans-serif;padding:3rem;text-align:center">'
  + '<h2>Login failed</h2><p>Return to the terminal and try /beezi-local-login again.</p>';

// One-shot loopback callback receiver. Binds 127.0.0.1:{port} (0 = ephemeral),
// resolves `code` with the authorization code from the first /callback hit carrying our state.
export async function startLoopback({ port = 0, expectedState, timeoutMs = 300_000 }) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  const redirectUri = `http://127.0.0.1:${actualPort}/callback`;

  const code = new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      clearTimeout(timer);
      server.close();
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new UserError('Login timed out before the browser round-trip completed.')),
      timeoutMs,
    );
    server.on('request', (req, res) => {
      let url;
      // A request target that URL cannot parse (absolute-form `http://[`) gets a 400, never a throw out of the listener.
      try { url = new URL(req.url, redirectUri); } catch {
        res.statusCode = 400;
        res.end();
        return;
      }
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const verdict = callbackOutcome(url.searchParams, expectedState);
      // A hit without our state (a local process, a prefetch) gets a bare 400 and the wait goes on until the timeout.
      if (verdict.outcome === CALLBACK_OUTCOMES.IGNORE) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const ok = verdict.outcome === CALLBACK_OUTCOMES.CODE;
      res.statusCode = ok ? 200 : 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(ok ? CLOSE_PAGE : FAIL_PAGE);
      if (ok) finish(resolve, verdict.code);
      else finish(reject, new UserError(`Authorization failed: ${verdict.error}.`));
    });
  });

  return { redirectUri, port: actualPort, code };
}
