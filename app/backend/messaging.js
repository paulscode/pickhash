'use strict';
/*
 * Owner-messaging helpers. An MRR rental message thread is the HIGHEST XSS surface in the
 * app: the rig owner authors `message` AND picks `username`, and MRR support can join the thread.
 * Safety model (same as rig strings): carry the strings RAW through the whole path and let
 * the UI render them with x-text (which sets textContent, neutralizing markup) — NEVER strip/escape
 * here (that would corrupt legitimate content) and NEVER emit HTML. This module only shapes the MRR
 * response; the actual defense lives in the frontend's x-text rendering (pinned by xss.test.js).
 */

/** Shape a GET /rental/[id]/message response into our thread model, preserving raw strings. */
function normalizeThread(raw) {
  const messages = (raw && raw.messages) || [];
  return messages.map((m) => ({
    username: String((m && m.username) || ''),
    is_admin: !!(m && m.is_admin),
    is_support: !!(m && m.is_support),
    when: m && m.when != null ? m.when : null,
    message: String((m && m.message) || ''),
  }));
}

module.exports = { normalizeThread };
