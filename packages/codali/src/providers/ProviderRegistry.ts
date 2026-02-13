import type { Provider, ProviderConfig } from "./ProviderTypes.js";

export type ProviderFactory = (config: ProviderConfig) => Provider;

export class ProviderRegistry {
  private factories = new Map<string, ProviderFactory>();

  register(name: string, factory: ProviderFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Provider already registered: ${name}`);
    }
    this.factories.set(name, factory);
  }

  create(name: string, config: ProviderConfig): Provider {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Unknown provider: ${name}`);
    }
    return factory(config);
  }

  list(): string[] {
    return Array.from(this.factories.keys());
  }
}

export const defaultProviderRegistry = new ProviderRegistry();

export const registerProvider = (name: string, factory: ProviderFactory): void => {
  defaultProviderRegistry.register(name, factory);
};

export const createProvider = (name: string, config: ProviderConfig): Provider => {
  return defaultProviderRegistry.create(name, config);
};
