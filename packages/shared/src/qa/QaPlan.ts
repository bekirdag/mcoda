export type QaPlan = {
  task_profiles?: Record<string, string[]>;
  task_plans?: Record<string, QaTaskPlan>;
  notes?: string;
};

export interface QaTaskPlan {
  profiles?: string[];
  cli?: {
    commands?: string[];
  };
  api?: {
    base_url?: string;
    requests?: QaApiRequest[];
  };
  browser?: {
    base_url?: string;
    actions?: QaBrowserAction[];
  };
  stress?: {
    api?: QaApiStress[];
    browser?: QaBrowserStress[];
  };
}

export interface QaApiExpectation {
  status?: number;
  json_contains?: Record<string, unknown>;
  text_includes?: string[];
}

export interface QaApiRequest {
  id?: string;
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  expect?: QaApiExpectation;
}

export type QaBrowserAction =
  | {
      type: 'navigate';
      url?: string;
      wait_for?: 'load' | 'idle';
      timeout_ms?: number;
    }
  | {
      type: 'click';
      selector: string;
      text?: string;
    }
  | {
      type: 'type';
      selector: string;
      text: string;
      clear?: boolean;
    }
  | {
      type: 'wait_for';
      selector?: string;
      timeout_ms?: number;
    }
  | {
      type: 'assert_text';
      selector?: string;
      text: string;
      contains?: boolean;
    }
  | {
      type: 'snapshot';
      name?: string;
    }
  | {
      type: 'script';
      expression: string;
      expect?: string;
    };

export interface QaBrowserStress {
  type: 'repeat';
  count: number;
  action: QaBrowserAction;
}

export interface QaApiStress {
  type: 'burst';
  count: number;
  request: QaApiRequest;
}
