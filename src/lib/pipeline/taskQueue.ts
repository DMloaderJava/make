/**
 * TaskQueue with retry, exponential backoff, rate limiting, persistence, fallback chain
 * Critical for real-world usage with 20+ pages
 */

import { lsKey } from '../storage/info';

export interface Task<T> {
  id: string;
  fn: () => Promise<T>;
  retries?: number;
  fallbackChain?: Array<() => Promise<T>>;
  priority?: number;
}

export interface TaskResult<T> {
  id: string;
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  fallbackUsed?: number; // index in fallbackChain
}

export interface QueueOptions {
  concurrency: number;
  retryDelay: number; // base ms
  maxRetries: number;
  rateLimit?: {
    maxRequests: number;
    perMs: number;
  };
  onProgress?: (completed: number, total: number, currentId: string) => void;
  onTaskComplete?: (result: TaskResult<any>) => void;
  persistKey?: string; // for persistence - saves progress to localStorage/IDB
}

export class TaskQueue {
  private queue: Task<any>[] = [];
  private running = 0;
  private completed = 0;
  private total = 0;
  private results: Map<string, TaskResult<any>> = new Map();
  private requestTimestamps: number[] = [];
  private options: QueueOptions;
  private aborted = false;

  constructor(options: Partial<QueueOptions> = {}) {
    this.options = {
      concurrency: 2,
      retryDelay: 1000,
      maxRetries: 3,
      ...options
    };
  }

  add<T>(task: Task<T>): void {
    this.queue.push(task);
    this.total++;
    // Sort by priority
    this.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  addMany<T>(tasks: Task<T>[]): void {
    for (const t of tasks) this.add(t);
  }

  async run(): Promise<Map<string, TaskResult<any>>> {
    this.aborted = false;
    this.completed = 0;
    this.results.clear();

    // Restore persisted progress - FIXED v1.1 Fixed++: don't use Math.max for total (causes 75% stuck bug)
    // This is now a progressKey, not a resumable queue - OPFS cache makes re-runs instant
    // We only keep timestamp for debugging, total always comes from current add() calls
    if (this.options.persistKey) {
      try {
        const saved = typeof window !== 'undefined' ? localStorage.getItem(lsKey(`taskqueue-${this.options.persistKey}`)) : null;
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.total === this.total) {
            this.completed = 0;
          } else {
            this.completed = 0;
          }
        }
      } catch {}
    }

    return new Promise((resolve, reject) => {
      const tryNext = async () => {
        if (this.aborted) {
          reject(new Error('Queue aborted'));
          return;
        }

        if (this.queue.length === 0 && this.running === 0) {
          if (this.options.persistKey) {
            try {
              localStorage.removeItem(lsKey(`taskqueue-${this.options.persistKey}`));
            } catch {}
          }
          resolve(this.results);
          return;
        }

        while (this.running < this.options.concurrency && this.queue.length > 0) {
          const task = this.queue.shift()!;
          this.running++;

          this.executeWithRetry(task)
            .then(result => {
              this.results.set(task.id, result);
              this.completed++;
              this.options.onProgress?.(this.completed, this.total, task.id);
              this.options.onTaskComplete?.(result);
              if (this.options.persistKey) {
                try {
                  const completedIds = Array.from(this.results.keys()).filter(k => this.results.get(k)?.success);
                  localStorage.setItem(lsKey(`taskqueue-${this.options.persistKey}`), JSON.stringify({
                    completedIds,
                    total: this.total,
                    completed: this.completed,
                    timestamp: Date.now()
                  }));
                } catch {}
              }
            })
            .catch(error => {
              const result: TaskResult<any> = {
                id: task.id,
                success: false,
                error: error as Error,
                attempts: this.options.maxRetries + 1
              };
              this.results.set(task.id, result);
              this.completed++;
              this.options.onProgress?.(this.completed, this.total, task.id);
              this.options.onTaskComplete?.(result);
            })
            .finally(() => {
              this.running--;
              tryNext();
            });
        }
      };

      tryNext();
    });
  }

  private async executeWithRetry<T>(task: Task<T>): Promise<TaskResult<T>> {
    let lastError: Error | null = null;
    let attempts = 0;

    for (let attempt = 0; attempt <= (task.retries ?? this.options.maxRetries); attempt++) {
      if (this.aborted) throw new Error('Queue aborted');
      attempts++;
      try {
        await this.enforceRateLimit();
        const data = await task.fn();
        if (this.aborted) throw new Error('Queue aborted');
        return { id: task.id, success: true, data, attempts };
      } catch (e) {
        if (this.aborted) throw new Error('Queue aborted');
        lastError = e as Error;
        if (!this.isRetryable(e as Error) || attempt === (task.retries ?? this.options.maxRetries)) break;
        const delay = this.options.retryDelay * Math.pow(2, attempt) + Math.random() * 1000;
        await this.sleep(delay);
      }
    }

    if (task.fallbackChain && task.fallbackChain.length > 0) {
      for (let i = 0; i < task.fallbackChain.length; i++) {
        if (this.aborted) throw new Error('Queue aborted');
        const fallbackFn = task.fallbackChain[i];
        try {
          await this.enforceRateLimit();
          const data = await fallbackFn();
          if (this.aborted) throw new Error('Queue aborted');
          return { id: task.id, success: true, data, attempts, fallbackUsed: i };
        } catch (e) {
          if (this.aborted) throw new Error('Queue aborted');
          lastError = e as Error;
        }
      }
    }

    return { id: task.id, success: false, error: lastError || new Error('Unknown error'), attempts };
  }

  private isRetryable(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504') ||
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('fetch')
    );
  }

  private async enforceRateLimit(): Promise<void> {
    if (!this.options.rateLimit) return;

    const now = Date.now();
    // Remove old timestamps
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < this.options.rateLimit!.perMs);

    if (this.requestTimestamps.length >= this.options.rateLimit!.maxRequests) {
      const oldest = this.requestTimestamps[0];
      const waitTime = this.options.rateLimit!.perMs - (now - oldest);
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }

    this.requestTimestamps.push(Date.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  abort(): void {
    this.aborted = true;
    this.queue = [];
  }

  getProgress(): { completed: number; total: number; running: number; queued: number } {
    return {
      completed: this.completed,
      total: this.total,
      running: this.running,
      queued: this.queue.length
    };
  }
}

// Specific helpers for TTS with caching and fallback
export interface TTSQueueItem {
  panelId: number;
  text: string;
  voice: string;
  provider: string;
  model?: string;
  speed?: number;
  emotion?: string;
  language?: string;
}

export async function createTTSQueue(
  items: TTSQueueItem[],
  options: {
    apiKeys: Record<string, string>;
    providers: any[]; // TTSProvider[]
    getCacheKey: (item: TTSQueueItem) => Promise<string>;
    loadCache: (key: string) => Promise<Blob | null>;
    saveCache: (key: string, blob: Blob) => Promise<void>;
    onProgress?: (completed: number, total: number, currentId: string) => void;
  }
): Promise<TaskQueue> {
  const queue = new TaskQueue({
    concurrency: 2,
    retryDelay: 1500,
    maxRetries: 3,
    rateLimit: { maxRequests: 5, perMs: 10000 }, // 5 req per 10 sec conservative
    onProgress: options.onProgress
  });

  for (const item of items) {
    const cacheKey = await options.getCacheKey(item);
    
    const mainProvider = options.providers.find(p => p.id === item.provider);
    const fallbackProviders = options.providers.filter(p => p.id !== item.provider);

    const task: Task<Blob> = {
      id: `tts-${item.panelId}`,
      priority: 0,
      fn: async () => {
        // Check cache first
        const cached = await options.loadCache(cacheKey);
        if (cached) return cached;

        if (!mainProvider) throw new Error(`Provider ${item.provider} not found`);
        const apiKey = options.apiKeys[item.provider];
        if (!apiKey) throw new Error(`No API key for ${item.provider}`);

        const buffer = await mainProvider.generate(item.text, {
          apiKey,
          voice: item.voice,
          model: item.model,
          speed: item.speed,
          language: item.language
        });

        const blob = new Blob([buffer], { type: 'audio/mpeg' });
        await options.saveCache(cacheKey, blob);
        return blob;
      },
      fallbackChain: fallbackProviders.map(fp => async () => {
        const cached = await options.loadCache(`${fp.id}-${cacheKey}`);
        if (cached) return cached;

        const apiKey = options.apiKeys[fp.id];
        if (!apiKey) throw new Error(`No key for fallback ${fp.id}`);

        const voices = await fp.getVoices(apiKey);
        const voice = voices[0]?.id || item.voice;

        const buffer = await fp.generate(item.text, {
          apiKey,
          voice,
          language: item.language
        });

        const blob = new Blob([buffer], { type: 'audio/mpeg' });
        await options.saveCache(`${fp.id}-${cacheKey}`, blob);
        return blob;
      })
    };

    queue.add(task);
  }

  return queue;
}
