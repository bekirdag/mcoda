import test from 'node:test';
import assert from 'node:assert/strict';
import packageJson from '../../package.json' with { type: 'json' };
import { McodaEntrypoint } from '../bin/McodaEntrypoint.js';
import { CloudCommands } from '../commands/cloud/CloudCommands.js';
import { ConfigCommands } from '../commands/config/ConfigCommands.js';
import { ConsentCommands } from '../commands/consent/ConsentCommands.js';
import { SdsPreflightCommand } from '../commands/planning/SdsPreflightCommand.js';
import { DocsCommands } from '../commands/docs/DocsCommands.js';
import { MswarmConfigStore } from '@mcoda/core';

const captureLogs = async (
  fn: () => Promise<void> | void
): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  // @ts-ignore override
  console.log = (...args: any[]) => {
    logs.push(args.join(' '));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
  }
  return logs;
};

const withConsentState = async (
  state: Record<string, unknown>,
  fn: () => Promise<void>
): Promise<void> => {
  const originalReadState = MswarmConfigStore.prototype.readState;
  (MswarmConfigStore.prototype as any).readState = async () => state;
  try {
    await fn();
  } finally {
    (MswarmConfigStore.prototype as any).readState = originalReadState;
  }
};

test('McodaEntrypoint prints version', { concurrency: false }, async () => {
  const logs = await captureLogs(() => McodaEntrypoint.run(['--version']));
  const output = logs.join('\n');
  assert.match(
    output,
    new RegExp(String((packageJson as any).version ?? 'dev'))
  );
});

test(
  'McodaEntrypoint disables stream io for --json',
  { concurrency: false },
  async () => {
    const originalStream = process.env.MCODA_STREAM_IO;
    try {
      delete process.env.MCODA_STREAM_IO;
      await captureLogs(() => McodaEntrypoint.run(['--version', '--json']));
      assert.equal(process.env.MCODA_STREAM_IO, '0');
    } finally {
      if (originalStream === undefined) {
        delete process.env.MCODA_STREAM_IO;
      } else {
        process.env.MCODA_STREAM_IO = originalStream;
      }
    }
  }
);

test(
  'McodaEntrypoint qa-tasks help prints usage',
  { concurrency: false },
  async () => {
    const logs = await captureLogs(() =>
      withConsentState(
        { consentAccepted: true, consentToken: 'token-123' },
        () => McodaEntrypoint.run(['qa-tasks', '--help'])
      )
    );
    assert.ok(logs.join('\n').includes('Usage: mcoda qa-tasks'));
  }
);

test(
  'McodaEntrypoint project-guidance help prints usage',
  { concurrency: false },
  async () => {
    const logs = await captureLogs(() =>
      withConsentState(
        { consentAccepted: true, consentToken: 'token-123' },
        () => McodaEntrypoint.run(['project-guidance', '--help'])
      )
    );
    assert.ok(logs.join('\n').includes('Usage: mcoda project-guidance'));
  }
);

test(
  'McodaEntrypoint rejects unknown commands',
  { concurrency: false },
  async () => {
    await withConsentState(
      { consentAccepted: true, consentToken: 'token-123' },
      async () => {
        await assert.rejects(
          () => McodaEntrypoint.run(['totally-unknown']),
          /Unknown command/
        );
      }
    );
  }
);

test(
  'McodaEntrypoint routes sds-preflight command',
  { concurrency: false },
  async () => {
    const originalRun = SdsPreflightCommand.run;
    let called = false;
    (SdsPreflightCommand as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['--json']);
    };
    try {
      await withConsentState(
        { consentAccepted: true, consentToken: 'token-123' },
        () => McodaEntrypoint.run(['sds-preflight', '--json'])
      );
      assert.equal(called, true);
    } finally {
      (SdsPreflightCommand as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint routes cloud agent commands',
  { concurrency: false },
  async () => {
    const originalRun = CloudCommands.run;
    let called = false;
    (CloudCommands as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['agent', 'list', '--json']);
    };
    try {
      await withConsentState(
        { consentAccepted: true, consentToken: 'token-123' },
        () => McodaEntrypoint.run(['cloud', 'agent', 'list', '--json'])
      );
      assert.equal(called, true);
    } finally {
      (CloudCommands as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint routes config commands',
  { concurrency: false },
  async () => {
    const originalRun = ConfigCommands.run;
    let called = false;
    (ConfigCommands as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['set', 'mswarm-api-key', 'cloud-key']);
    };
    try {
      await McodaEntrypoint.run([
        'config',
        'set',
        'mswarm-api-key',
        'cloud-key',
      ]);
      assert.equal(called, true);
    } finally {
      (ConfigCommands as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint routes consent commands without prior consent',
  { concurrency: false },
  async () => {
    const originalRun = ConsentCommands.run;
    let called = false;
    (ConsentCommands as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['accept', '--json']);
    };
    try {
      await McodaEntrypoint.run(['consent', 'accept', '--json']);
      assert.equal(called, true);
    } finally {
      (ConsentCommands as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint blocks non-exempt commands until consent is accepted',
  { concurrency: false },
  async () => {
    await withConsentState(
      { consentAccepted: false, consentToken: undefined },
      async () => {
        await assert.rejects(
          () => McodaEntrypoint.run(['cloud', 'agent', 'list', '--json']),
          /Telemetry consent is required before using mcoda/
        );
      }
    );
  }
);

test(
  'McodaEntrypoint routes sds suggestions subcommand',
  { concurrency: false },
  async () => {
    const originalRun = DocsCommands.run;
    let called = false;
    (DocsCommands as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['sds', 'suggestions', '--project', 'ABC']);
    };
    try {
      await withConsentState(
        { consentAccepted: true, consentToken: 'token-123' },
        () => McodaEntrypoint.run(['sds', 'suggestions', '--project', 'ABC'])
      );
      assert.equal(called, true);
    } finally {
      (DocsCommands as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint keeps default sds generate routing',
  { concurrency: false },
  async () => {
    const originalRun = DocsCommands.run;
    let called = false;
    (DocsCommands as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['sds', 'generate', '--project', 'ABC']);
    };
    try {
      await withConsentState(
        { consentAccepted: true, consentToken: 'token-123' },
        () => McodaEntrypoint.run(['sds', '--project', 'ABC'])
      );
      assert.equal(called, true);
    } finally {
      (DocsCommands as any).run = originalRun;
    }
  }
);
