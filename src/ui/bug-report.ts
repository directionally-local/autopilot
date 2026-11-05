/**
 * Where a stuck person reports a bug: GitHub issues, or email for people
 * without a GitHub account. Shown by /bug, at the foot of /help, and after a
 * turn that failed for good. Nothing is filed automatically. Anything that
 * isn't a bug goes to /feedback (feedback.ts), which emails the team.
 */

export const BUG_REPORT_URL = "https://github.com/directionally-local/autopilot/issues/new";
export const BUG_REPORT_EMAIL = "contact@directionallylocal.com";
export const BUG_REPORT_LINE = `Report a bug: ${BUG_REPORT_URL} · or email ${BUG_REPORT_EMAIL} · Feedback: /feedback`;
