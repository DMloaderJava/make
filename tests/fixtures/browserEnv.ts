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
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
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

/** Инъекция сбоев файловой системы в тестах (вернуть ошибку — она будет брошена). */
export const fsFaults: { removeEntry: ((name: string) => Error | undefined) | null } = { removeEntry: null };

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
  /** Как в настоящем OPFS: удалить отсутствующее — NotFoundError. */
  async removeEntry(name: string): Promise<void> {
    const fault = fsFaults.removeEntry?.(name);
    if (fault) throw fault;
    if (this.files.delete(name) || this.dirs.delete(name)) return;
    throw new DOMException(`${name} not found`, 'NotFoundError');
  }
  async *entries(): AsyncIterable<[string, FakeDirHandle | FakeFileHandle]> {
    for (const [k, v] of this.dirs.entries()) yield [k, v];
    for (const [k, v] of this.files.entries()) yield [k, v];
  }
}

/**
 * Полноценная in-memory реализация OfflineAudioContext для Node-тестов:
 * для реальных WAV-буферов (RIFF/WAVE) вычисляет точную длительность из заголовка,
 * а для фиктивных коротких буферов возвращает 1.5 с.
 */
class FakeAudioBufferImpl {
  readonly duration: number;
  private channelsData: Float32Array[];

  constructor(
    public readonly numberOfChannels: number,
    public readonly length: number,
    public readonly sampleRate: number,
    initialFill = 0
  ) {
    this.duration = sampleRate > 0 ? length / sampleRate : 0;
    this.channelsData = Array.from(
      { length: Math.max(1, numberOfChannels) },
      () => new Float32Array(Math.max(1, length)).fill(initialFill)
    );
  }

  getChannelData(ch = 0): Float32Array {
    return this.channelsData[ch] ?? this.channelsData[0];
  }

  copyToChannel(source: Float32Array, channelNumber = 0): void {
    const target = this.channelsData[channelNumber];
    if (target) {
      target.set(source.subarray(0, target.length));
    }
  }
}

class FakeOfflineAudioContext {
  readonly destination = { connect: () => {}, disconnect: () => {} };
  private scheduled: Array<{ buffer: FakeAudioBufferImpl; when: number; playDuration: number }> = [];

  constructor(
    public readonly numberOfChannels = 2,
    public readonly length = 44100,
    public readonly sampleRate = 44100
  ) {}

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBufferImpl {
    return new FakeAudioBufferImpl(channels, length, sampleRate);
  }

  createBufferSource() {
    const scheduled = this.scheduled;
    const src = {
      buffer: null as FakeAudioBufferImpl | null,
      onended: null as (() => void) | null,
      connect: () => {},
      disconnect: () => {},
      stop: () => {},
      start: (when = 0, _offset = 0, duration?: number) => {
        if (src.buffer) {
          scheduled.push({
            buffer: src.buffer,
            when,
            playDuration: duration !== undefined ? Math.min(duration, src.buffer.duration) : src.buffer.duration,
          });
        }
      },
    };
    return src;
  }

  async decodeAudioData(data: ArrayBuffer): Promise<FakeAudioBufferImpl> {
    let duration = 1.5;
    let sampleRate = this.sampleRate || 44100;
    let channels = 1;
    if (data && data.byteLength >= 44) {
      const view = new DataView(data);
      const riff = view.getUint32(0, false);
      const wave = view.getUint32(8, false);
      if (riff === 0x52494646 && wave === 0x57415645) {
        channels = Math.max(1, view.getUint16(22, true));
        sampleRate = Math.max(1, view.getUint32(24, true));
        const byteRate = view.getUint32(28, true);
        const dataSize = view.getUint32(40, true);
        if (byteRate > 0 && dataSize > 0) {
          duration = dataSize / byteRate;
        }
      }
    }
    const frames = Math.max(1, Math.round(duration * sampleRate));
    return new FakeAudioBufferImpl(channels, frames, sampleRate, 0.25);
  }

  async startRendering(): Promise<FakeAudioBufferImpl> {
    const out = new FakeAudioBufferImpl(this.numberOfChannels, this.length, this.sampleRate, 0);
    for (const item of this.scheduled) {
      const startFrame = Math.max(0, Math.round(item.when * this.sampleRate));
      const playFrames = Math.max(0, Math.round(item.playDuration * this.sampleRate));
      for (let ch = 0; ch < this.numberOfChannels; ch++) {
        const srcData = item.buffer.getChannelData(Math.min(ch, item.buffer.numberOfChannels - 1));
        const dstData = out.getChannelData(ch);
        const count = Math.min(playFrames, srcData.length, Math.max(0, dstData.length - startFrame));
        for (let i = 0; i < count; i++) {
          dstData[startFrame + i] += srcData[i];
        }
      }
    }
    return out;
  }
}

const g = globalThis as any;

g.localStorage = new MemoryStorage();
g.OfflineAudioContext = FakeOfflineAudioContext;

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
