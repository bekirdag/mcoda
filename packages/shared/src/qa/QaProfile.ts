export interface QaProfile {
  name: string;
  runner?: 'cli' | 'chromium' | 'maestro' | string;
  level?: string;
  test_command?: string;
  working_dir?: string;
  env?: Record<string, string>;
  default?: boolean;
  matcher?: {
    task_types?: string[];
    tags?: string[];
  };
  install_command?: string;
}
