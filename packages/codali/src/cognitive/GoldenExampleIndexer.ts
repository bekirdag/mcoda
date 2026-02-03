import type { DocdexClient } from "../docdex/DocdexClient.js";

export interface GoldenExample {
  intent: string;
  patch: string;
  score?: number;
}

export class GoldenExampleIndexer {
  constructor(private client: DocdexClient) {}

  async findExamples(intent: string, limit = 3): Promise<GoldenExample[]> {
    try {
      // 1. Recall from Repo Memory using the intent
      const result = await this.client.memoryRecall(intent, limit * 3);
      const hits = (result as { results?: Array<{ content: string; score: number }> }).results || [];

      const examples: GoldenExample[] = [];
      
      for (const hit of hits) {
        if (!hit.content.startsWith("GOLDEN_EXAMPLE")) continue;
        
        // Parse the stored format:
        // GOLDEN_EXAMPLE
        // INTENT: <intent>
        // PATCH: <patch>
        
        const intentMatch = hit.content.match(/INTENT:\s*(.*?)\nPATCH:/s);
        const patchMatch = hit.content.match(/PATCH:\s*([\s\S]*)$/);
        
        if (intentMatch && patchMatch) {
            examples.push({
                intent: intentMatch[1].trim(),
                patch: patchMatch[1].trim(),
                score: hit.score
            });
        }
      }

      return examples.slice(0, limit);
    } catch {
      return [];
    }
  }
}