// Single source of truth for the Homebase deployment URL. Every place that
// builds a Homebase link — manager Approve/Deny/Distribute magic-link
// buttons, "Review in Homebase" CTAs in manager-facing emails — must call
// getHomebaseUrl(). HOMEBASE_URL is the source of truth; there is no in-code
// default so a missing/wrong env var fails loud at send time instead of
// silently pointing at a stale preview deploy.

export function getHomebaseUrl(): string {
  const url = process.env.HOMEBASE_URL;
  if (!url) {
    throw new Error(
      'HOMEBASE_URL environment variable is not set. ' +
        'Set it to the current Homebase deployment URL ' +
        '(e.g. https://homebase-nine-phi.vercel.app) before sending any ' +
        'email that contains a Homebase magic-link or CTA.'
    );
  }
  return url;
}
