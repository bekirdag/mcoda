import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QaTestCommandBuilder } from '../QaTestCommandBuilder.js';

const makeTask = (testRequirements: Record<string, string[]>) =>
  ({
    id: 1,
    key: 'task-1',
    metadata: { test_requirements: testRequirements },
  }) as any;

test('qa test command builder uses plan commands when provided', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-cmd-'));
  try {
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['x'], component: [], integration: [], api: [] }),
      planCommands: ['node -e "console.log(1)"', 'node -e "console.log(2)"'],
    });
    assert.deepEqual(result.commands, ['node -e "console.log(1)"', 'node -e "console.log(2)"']);
    assert.equal(result.source, 'plan');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses profile command when provided', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-profile-'));
  try {
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['x'], component: [], integration: [], api: [] }),
      profileCommand: 'node tests/all.js',
    });
    assert.deepEqual(result.commands, ['node tests/all.js']);
    assert.equal(result.source, 'profile');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses node scripts per category', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-node-'));
  try {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'demo',
          version: '1.0.0',
          scripts: {
            'test:unit': 'node -e "console.log(1)"',
            'test:integration': 'node -e "console.log(2)"',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: ['i'], api: [] }),
    });
    assert.deepEqual(result.commands, ['npm run test:unit', 'npm run test:integration']);
    assert.equal(result.source, 'stack');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder orders node category commands', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-node-order-'));
  try {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'demo',
          version: '1.0.0',
          scripts: {
            'test:integration': 'node -e "console.log(3)"',
            'test:unit': 'node -e "console.log(1)"',
            'test:component': 'node -e "console.log(2)"',
            'test:api': 'node -e "console.log(4)"',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: ['c'], integration: ['i'], api: ['a'] }),
    });
    assert.deepEqual(result.commands, [
      'npm run test:unit',
      'npm run test:component',
      'npm run test:integration',
      'npm run test:api',
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses vitest runner when scripts are missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-node-runner-'));
  try {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', scripts: {} }, null, 2),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'vite.config.ts'), 'export default {};\n', 'utf8');
    await fs.mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['npx vitest run tests/unit']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses mocha runner when dependency is present', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-node-mocha-'));
  try {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'demo',
          version: '1.0.0',
          scripts: {},
          devDependencies: { mocha: '^10.0.0' },
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['npx mocha tests/unit']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder prefers file hints over workspace signals', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-hints-'));
  try {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', scripts: {} }, null, 2),
      'utf8',
    );
    await fs.mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
    const task = makeTask({ unit: ['u'], component: [], integration: [], api: [] });
    task.metadata.files = ['src/app.py'];
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({ task });
    assert.deepEqual(result.commands, ['pytest tests/unit']);
    assert.equal(result.stack, 'python');
    assert.equal(result.source, 'stack');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses python directories for categories', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-py-'));
  try {
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
    await fs.mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['pytest tests/unit']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses nose2 when nose2 config exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-nose2-'));
  try {
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
    await fs.writeFile(path.join(dir, 'nose2.cfg'), '[unittest]\n', 'utf8');
    await fs.mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['nose2 -s tests/unit']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses dotnet csproj when present', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-dotnet-'));
  try {
    await fs.writeFile(path.join(dir, 'Demo.csproj'), '<Project></Project>\n', 'utf8');
    await fs.mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'tests', 'unit', 'TestProject.csproj'),
      '<Project></Project>\n',
      'utf8',
    );
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['dotnet test tests/unit/TestProject.csproj']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses maven tests by category', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-java-mvn-'));
  try {
    await fs.writeFile(path.join(dir, 'pom.xml'), '<project></project>\n', 'utf8');
    await fs.mkdir(path.join(dir, 'src', 'test', 'java', 'unit'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['mvn -Dtest=*unit* test']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses gradle wrapper when present', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-java-gradle-'));
  try {
    await fs.writeFile(path.join(dir, 'gradlew'), '#!/bin/sh\n', 'utf8');
    await fs.mkdir(path.join(dir, 'src', 'test', 'java', 'integration'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: [], component: [], integration: ['i'], api: [] }),
    });
    assert.deepEqual(result.commands, ['./gradlew test --tests \\\"*integration*\\\"']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses go test for category directories', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-go-'));
  try {
    await fs.writeFile(path.join(dir, 'go.mod'), 'module demo\n', 'utf8');
    await fs.mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['go test ./tests/unit']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder falls back to go test ./... when no category dirs exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-go-fallback-'));
  try {
    await fs.writeFile(path.join(dir, 'go.mod'), 'module demo\n', 'utf8');
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['go test ./...']);
    assert.equal(result.stack, 'go');
    assert.equal(result.source, 'fallback');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses phpunit for category directories', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-php-'));
  try {
    await fs.writeFile(path.join(dir, 'composer.json'), '{}\n', 'utf8');
    await fs.mkdir(path.join(dir, 'vendor', 'bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'vendor', 'bin', 'phpunit'), '', 'utf8');
    await fs.mkdir(path.join(dir, 'tests', 'api'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: [], component: [], integration: [], api: ['a'] }),
    });
    assert.deepEqual(result.commands, ['vendor/bin/phpunit tests/api']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses pest when available', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-php-pest-'));
  try {
    await fs.writeFile(path.join(dir, 'composer.json'), '{}\n', 'utf8');
    await fs.mkdir(path.join(dir, 'vendor', 'bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'vendor', 'bin', 'pest'), '', 'utf8');
    await fs.mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['vendor/bin/pest tests/unit']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses rspec when spec categories exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-ruby-'));
  try {
    await fs.writeFile(path.join(dir, 'Gemfile'), "source 'https://rubygems.org'\n", 'utf8');
    await fs.mkdir(path.join(dir, 'spec', 'integration'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: [], component: [], integration: ['i'], api: [] }),
    });
    assert.deepEqual(result.commands, ['bundle exec rspec spec/integration']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder uses minitest when no rakefile or specs exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-ruby-mini-'));
  try {
    await fs.writeFile(path.join(dir, 'Gemfile'), "source 'https://rubygems.org'\n", 'utf8');
    await fs.mkdir(path.join(dir, 'test', 'unit'), { recursive: true });
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, [
      'bundle exec ruby -I test -e \\\"Dir[\'test/unit/**/*_test.rb\'].each { |f| require f }\\\"',
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder falls back to tests/all.js', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-all-'));
  try {
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tests', 'all.js'), 'console.log("ok");\n', 'utf8');
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['node tests/all.js']);
    assert.equal(result.source, 'fallback');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('qa test command builder falls back to npm test when categories are missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-qa-fallback-'));
  try {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'demo',
          version: '1.0.0',
          scripts: {
            test: 'node -e "console.log(1)"',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const builder = new QaTestCommandBuilder(dir);
    const result = await builder.build({
      task: makeTask({ unit: ['u'], component: [], integration: [], api: [] }),
    });
    assert.deepEqual(result.commands, ['npm test']);
    assert.equal(result.source, 'fallback');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
