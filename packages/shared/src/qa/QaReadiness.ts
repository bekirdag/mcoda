export type QaEntrypointKind = 'web' | 'api' | 'cli';

export interface QaEntrypoint {
  kind: QaEntrypointKind;
  base_url?: string;
  command?: string;
}

export interface QaReadiness {
  profiles_expected?: string[];
  requires?: string[];
  entrypoints?: QaEntrypoint[];
  data_setup?: string[];
  blockers?: string[];
  notes?: string;
}
