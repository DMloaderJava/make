import type { Project } from '@/lib/storage/db';

/**
 * Синхронизирует только данные проекта. Ключи провайдеров лежат в localStorage
 * и намеренно никогда не отправляются на сервер.
 */
export async function syncProjectSnapshot(project: Project): Promise<{ expiresAt: string } | null> {
  if (typeof window === 'undefined') return null;
  try {
    const response = await fetch('/api/cloud/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, project }),
    });
    if (!response.ok) {
      if (response.status === 503) return null; // Supabase ещё не настроен — локальный режим остаётся рабочим.
      throw new Error(`Cloud sync failed (${response.status})`);
    }
    const data = (await response.json()) as { expiresAt?: string; skipped?: boolean };
    if (data.skipped || !data.expiresAt) return null;
    return { expiresAt: data.expiresAt };
  } catch (error) {
    console.warn('[cloud] snapshot sync skipped:', error);
    return null;
  }
}

export async function deleteProjectSnapshot(projectId: string): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await fetch(`/api/cloud/project?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  } catch (error) {
    console.warn('[cloud] snapshot delete skipped:', error);
  }
}
