/**
 * P1 tab-restore revalidation: which session-detail load failures mean the
 * tab's session is gone or invisible (auto-close) versus transient (keep).
 */
export function shouldCloseTabOnLoadFailure(status: number): boolean {
	return status === 404 || status === 403;
}
