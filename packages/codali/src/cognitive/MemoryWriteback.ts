import type { DocdexClient } from "../docdex/DocdexClient.js";

export interface PreferenceWriteback {
  category: string;
  content: string;
  agentId?: string;
}

export interface MemoryWritebackInput {
  failures: number;
  maxRetries: number;
  lesson: string;
  preferences?: PreferenceWriteback[];
}

export interface MemoryWritebackOptions {
  agentId?: string;
}

const isUnsupportedDocdexMethod = (error: unknown): boolean => {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("unknown method") || normalized.includes("method not found");
};

export class MemoryWriteback {
  private agentId: string;

  constructor(private client: DocdexClient, options: MemoryWritebackOptions = {}) {
    this.agentId = options.agentId ?? "default";
  }

  async persist(input: MemoryWritebackInput): Promise<void> {
    if (input.failures >= input.maxRetries && input.lesson.trim()) {
      try {
        await this.client.memorySave(input.lesson.trim());
      } catch (error) {
        if (!isUnsupportedDocdexMethod(error)) {
          throw error;
        }
      }
    }
    if (input.preferences?.length) {
      for (const preference of input.preferences) {
        try {
          await this.client.savePreference(
            preference.agentId ?? this.agentId,
            preference.category,
            preference.content,
          );
        } catch (error) {
          if (!isUnsupportedDocdexMethod(error)) {
            throw error;
          }
        }
      }
    }
  }
}
