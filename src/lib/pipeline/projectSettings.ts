/** Prefer an explicit selection, then the project's live selection, then the app default. */
export function resolveTTSProviderId(
  projectProviderId: string | null | undefined,
  defaultProviderId: string | null | undefined,
  selectedProviderId?: string | null
): string {
  return selectedProviderId?.trim() || projectProviderId?.trim() || defaultProviderId?.trim() || '';
}
