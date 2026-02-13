export type QaTestCategory = 'unit' | 'component' | 'integration' | 'api';
export type QaToolCategory =
  | QaTestCategory
  | 'e2e'
  | 'mocking'
  | 'load'
  | 'contract';

export type QaTechStackId =
  | 'node'
  | 'python'
  | 'dotnet'
  | 'java'
  | 'go'
  | 'php'
  | 'ruby'
  | 'flutter'
  | 'react-native'
  | 'ios'
  | 'android'
  | 'cross-stack';

export type QaToolCatalog = Partial<Record<QaToolCategory, string[]>>;

export type QaToolPreferences = Partial<Record<QaToolCategory, string>>;

export interface QaTechStack {
  id: QaTechStackId;
  label: string;
  tools: QaToolCatalog;
  preferred?: QaToolPreferences;
}

export const QA_TEST_CATEGORY_ORDER: QaTestCategory[] = [
  'unit',
  'component',
  'integration',
  'api',
];

export const QA_TECH_STACKS: Record<QaTechStackId, QaTechStack> = {
  node: {
    id: 'node',
    label: 'JavaScript / TypeScript (Node.js, React, Next.js)',
    tools: {
      unit: ['Jest', 'Vitest', 'Mocha + Chai', 'AVA'],
      integration: ['Jest', 'Vitest', 'Mocha + Chai', 'AVA'],
      api: ['Supertest', 'Axios Mock Adapter', 'Nock'],
      component: ['Testing Library'],
      e2e: ['Chromium', 'Cypress (Chromium only)', 'Puppeteer (Chromium only)'],
    },
    preferred: {
      unit: 'Vitest',
      integration: 'Vitest',
      api: 'Supertest',
      component: 'Testing Library',
      e2e: 'Chromium',
    },
  },
  python: {
    id: 'python',
    label: 'Python (FastAPI, Django, Flask)',
    tools: {
      unit: ['pytest', 'unittest', 'nose2'],
      integration: ['pytest', 'unittest', 'nose2'],
      api: ['httpx', 'requests', 'pytest-httpx', 'pytest-django', 'pytest-flask'],
      e2e: ['Chromium', 'Selenium (Chromium only)'],
    },
    preferred: {
      unit: 'pytest',
      integration: 'pytest',
      api: 'httpx',
      e2e: 'Chromium',
    },
  },
  dotnet: {
    id: 'dotnet',
    label: 'C# / .NET',
    tools: {
      unit: ['xUnit', 'NUnit', 'MSTest'],
      integration: ['xUnit', 'NUnit', 'MSTest'],
      mocking: ['Moq', 'NSubstitute', 'FakeItEasy'],
      api: [
        'Microsoft.AspNetCore.Mvc.Testing',
        'RestSharp',
        'WireMock.Net',
      ],
      e2e: ['Chromium', 'Selenium (Chromium only)'],
    },
    preferred: {
      unit: 'xUnit',
      integration: 'xUnit',
      mocking: 'Moq',
      api: 'Microsoft.AspNetCore.Mvc.Testing',
      e2e: 'Chromium',
    },
  },
  java: {
    id: 'java',
    label: 'Java (Spring Boot)',
    tools: {
      unit: ['JUnit 5', 'TestNG'],
      integration: ['JUnit 5', 'TestNG'],
      mocking: ['Mockito', 'MockK'],
      api: ['Spring MockMvc', 'REST Assured', 'WireMock'],
      e2e: ['Chromium', 'Selenium (Chromium only)'],
    },
    preferred: {
      unit: 'JUnit 5',
      integration: 'JUnit 5',
      mocking: 'Mockito',
      api: 'Spring MockMvc',
      e2e: 'Chromium',
    },
  },
  go: {
    id: 'go',
    label: 'Go',
    tools: {
      unit: ['testing', 'testify', 'ginkgo + gomega'],
      integration: ['testing', 'testify', 'ginkgo + gomega'],
      api: ['httptest', 'resty'],
      mocking: ['gomock', 'testify/mock'],
    },
    preferred: {
      unit: 'testing',
      integration: 'testing',
      api: 'httptest',
      mocking: 'gomock',
    },
  },
  php: {
    id: 'php',
    label: 'PHP (Laravel, Symfony)',
    tools: {
      unit: ['PHPUnit', 'Pest'],
      integration: ['PHPUnit', 'Pest'],
      api: ['Laravel HTTP Tests', 'Symfony WebTestCase'],
      e2e: ['Laravel Dusk (Chromium only)', 'Chromium', 'Cypress (Chromium only)'],
    },
    preferred: {
      unit: 'PHPUnit',
      integration: 'PHPUnit',
      api: 'Laravel HTTP Tests',
      e2e: 'Chromium',
    },
  },
  ruby: {
    id: 'ruby',
    label: 'Ruby (Rails)',
    tools: {
      unit: ['RSpec', 'Minitest'],
      integration: ['RSpec', 'Minitest'],
      api: ['Rack::Test'],
      e2e: ['Capybara (Chromium only)', 'Chromium'],
    },
    preferred: {
      unit: 'RSpec',
      integration: 'RSpec',
      api: 'Rack::Test',
      e2e: 'Chromium',
    },
  },
  flutter: {
    id: 'flutter',
    label: 'Flutter',
    tools: {
      unit: ['flutter_test'],
      integration: ['integration_test'],
      mocking: ['mockito'],
    },
    preferred: {
      unit: 'flutter_test',
      integration: 'integration_test',
      mocking: 'mockito',
    },
  },
  'react-native': {
    id: 'react-native',
    label: 'React Native',
    tools: {
      unit: ['Jest'],
      integration: ['Jest'],
      component: ['React Native Testing Library'],
      e2e: ['Detox'],
    },
    preferred: {
      unit: 'Jest',
      integration: 'Jest',
      component: 'React Native Testing Library',
      e2e: 'Detox',
    },
  },
  ios: {
    id: 'ios',
    label: 'iOS (Swift)',
    tools: {
      unit: ['XCTest', 'Quick + Nimble'],
      integration: ['XCTest', 'Quick + Nimble'],
    },
    preferred: {
      unit: 'XCTest',
      integration: 'XCTest',
    },
  },
  android: {
    id: 'android',
    label: 'Android (Kotlin)',
    tools: {
      unit: ['JUnit'],
      integration: ['Espresso'],
      mocking: ['MockK'],
    },
    preferred: {
      unit: 'JUnit',
      integration: 'Espresso',
      mocking: 'MockK',
    },
  },
  'cross-stack': {
    id: 'cross-stack',
    label: 'Cross-Stack / Infra / Contract',
    tools: {
      e2e: ['Chromium'],
      api: ['Postman / Newman'],
      load: ['k6', 'Artillery'],
      contract: ['Pact'],
      mocking: ['Testcontainers'],
    },
    preferred: {
      e2e: 'Chromium',
      load: 'k6',
      contract: 'Pact',
    },
  },
};
