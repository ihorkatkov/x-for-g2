export class BackendError extends Error {
  constructor(public code: string, public status = 502, public retryAfter?: number) {
    super(code);
  }
}
export const messages: Record<string, string> = {
  bookmark_failed:'X did not save the bookmark. Try again in X.',bookmark_unknown:'Bookmark result is uncertain. Check your X bookmarks before retrying.',post_unavailable:'Refresh this post before bookmarking it.',
  pairing_required:'Pair this phone with the laptop to read your feed.', pairing_invalid:'Pairing code invalid, expired or locked. Generate a new laptop code.',
  invalid_request: 'Invalid request.', forbidden: 'Request not allowed.',
  not_found: 'Not found.', not_configured: 'Live credentials are not configured.',
  expired: 'The X session has expired. Update private server environment and restart.',
  blocked: 'X denied this request. Check account access outside X.',
  rate_limited: 'X is rate limiting requests. Try again later.',
  busy: 'A feed request is already running.', cursor_expired: 'Cursor expired. Refresh the feed.',
  upstream_changed: 'X response or query format changed. Live feed is unavailable.',
  upstream_unavailable: 'X is unavailable or timed out.', internal: 'Backend unavailable.',
};
