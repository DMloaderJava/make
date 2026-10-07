/**
 * Минимальное браузерное окружение для Node-тестов: localStorage, window
 * (OfflineAudioContext) и in-memory OPFS (navigator.storage.getDirectory).
 *
 * Модуль должен импортироваться ПЕРВЫМ в тестовом файле — до модулей,
 * которые трогают эти глобалы (node --test гоняет каждый файл в отдельном
 * процессе, поэтому глобалы не утекают между файлами).
 *
 * Зачем OPFS-заглушка: writeFile() в src/lib/storage/opfs.ts честно бросает
 * «OPFS not supported» вне браузера, и без заглушки generateAllAudio() падала
 * бы на saveTTSCache/saveProjectAudio. In-memory ручки позволяют прогнать
 * реальный путь (сохранение → подпись → повторное чтение) без браузера.
 */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

class FakeWritable {
  constructor(private file: FakeFileHandle) {}
  async write(data: Blob | ArrayBuffer | string): Promise<void> {
    this.file.stored = data instanceof Blob ? data : new Blob([data as ArrayBuffer]);
  }
  async close(): Promise<void> {}
}

class FakeFileHandle {
  kind = 'file' as const;
  stored: Blob | null = null;
  async createWritable(): Promise<FakeWritable> {
    return new FakeWritable(this);
  }
  async getFile(): Promise<Blob> {
    if (!this.stored) throw new Error('файл пуст');
    return this.stored;
  }
}

class FakeDirHandle {
  kind = 'directory' as const;
  private dirs = new Map<string, FakeDirHandle>();
  private files = new Map<string, FakeFileHandle>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!opts?.create) throw new Error(`нет директории ${name}`);
      dir = new FakeDirHandle();
      this.dirs.set(name, dir);
    }
    return dir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let file = this.files.get(name);
    if (!file) {
      if (!opts?.create) throw new Error(`нет файла ${name}`);
      file = new FakeFileHandle();
      this.files.set(name, file);
    }
    return file;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) this.dirs.delete(name);
  }
}

/** Длительность «декодированного» аудио фиксирована: важен факт вызова, не точность. */
class FakeOfflineAudioContext {
  constructor(_channels: number, _length: number, _sampleRate: number) {}
  async decodeAudioData(_data: ArrayBuffer): Promise<{ duration: number }> {
    return { duration: 1.5 };
  }
}

const g = globalThis as any;

g.localStorage = new MemoryStorage();

// window нужен generateTTS (assertClientContext) и getAudioDuration (OfflineAudioContext).
g.window = {
  OfflineAudioContext: FakeOfflineAudioContext,
  AudioContext: FakeOfflineAudioContext,
};

// В Node 22 есть свой read-only navigator — заменяем целиком на совместимый.
Object.defineProperty(g, 'navigator', {
  value: {
    storage: {
      getDirectory: async () => new FakeDirHandle(),
    },
  },
  configurable: true,
  writable: true,
});

export { FakeDirHandle };
