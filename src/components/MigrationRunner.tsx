"use client";

import { useEffect } from 'react';

export function MigrationRunner() {
  useEffect(() => {
    (async () => {
      try {
        const { runMigration } = await import('@/lib/storage/migrate');
        await runMigration();
      } catch (e) {
        console.error('[mvs-info] migration error', e);
      }

      // dev helper window.mvsInfo
      if (process.env.NODE_ENV !== 'production') {
        try {
          const info = await import('@/lib/storage/info');
          (window as any).mvsInfo = {
            clearAll: info.clearAllInfo,
            exportAll: () => info.exportAllInfo({ includeKeys: true }),
            exportAllWithFiles: () => info.exportAllInfoWithFiles({ includeKeys: true }),
            exportWithoutKeys: () => info.exportAllInfo({ includeKeys: false }),
            usage: info.getInfoUsage,
            lsKey: info.lsKey,
            INFO_NAMESPACE: info.INFO_NAMESPACE,
          };
          console.log('[mvs-info] dev helper: window.mvsInfo available (clearAll, exportAll, usage)');
        } catch {}
      }
    })();
  }, []);
  return null;
}
