/**
 * Messages the workspace form can show after a failed create/join.
 *
 * The action redirects back to /start with one of these codes instead of
 * throwing: Next.js omits a thrown Server Action error's message in
 * production, which turned a mistyped team code into a full "This page
 * couldn't load" error page. Codes rather than free text, so a crafted link
 * can't put arbitrary words on the page.
 */
export const START_ERRORS = {
  "name-required": "Your name is required.",
  "address-required": "Office label and address are required.",
  "workspace-name-required": "Workspace name is required.",
  "address-not-found": "Could not find that address. Try adding city and state.",
  "code-required": "Company code is required.",
  "code-not-found": "No workspace found for that code — double check it or create a new one.",
} as const;

export type StartErrorCode = keyof typeof START_ERRORS;

export function startErrorMessage(code: string | undefined): string | null {
  return code && Object.hasOwn(START_ERRORS, code) ? START_ERRORS[code as StartErrorCode] : null;
}
