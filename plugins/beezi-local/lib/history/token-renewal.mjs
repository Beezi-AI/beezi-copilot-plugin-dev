// The history run's one token renewal, shared by every upload lane: it reads and writes run.session, which registration also renews.

// → renewSession(stale): the current session if a lane already renewed, else one shared forced refresh per stale token, else null.
export function createRenewal(run) {
  let renewal = null;
  // Tokens already refreshed from or minted by a refresh; a 401 on one of them answers null with no new refresh.
  const spent = new Set();
  const refresh = () => new Promise((resolve) => {
    resolve(run.io.getAccessToken({}, { account: run.key, forceRefresh: true }));
  }).catch(() => null);
  return function renewSession(stale) {
    if (stale.token !== run.session.token) return Promise.resolve(run.session);
    if (renewal) return renewal;
    if (spent.has(stale.token)) return Promise.resolve(null);
    spent.add(stale.token);
    renewal = refresh().then((next) => {
      renewal = null;
      if (!next || next === run.session.token) return null;
      spent.add(next);
      run.session = { ...run.session, token: next };
      return run.session;
    });
    return renewal;
  };
}
