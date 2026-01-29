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

export class MemoryWriteback {
  private agentId: string;

  constructor(private client: DocdexClient, options: MemoryWritebackOptions = {}) {
    this.agentId = options.agentId ?? "default";
  }

  async persist(input: MemoryWritebackInput): Promise<void> {
    if (input.failures >= input.maxRetries && input.lesson.trim()) {
      await this.client.memorySave(input.lesson.trim());
    }
    if (input.preferences?.length) {
      for (const preference of input.preferences) {
        await this.client.savePreference(
          preference.agentId ?? this.agentId,
          preference.category,
          preference.content,
        );
      }
    }
  }
}
