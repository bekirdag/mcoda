import test from 'node:test';
import assert from 'node:assert/strict';
import packageJson from '../../package.json' with { type: 'json' };
import { McodaEntrypoint } from '../bin/McodaEntrypoint.js';
import { CloudCommands } from '../commands/cloud/CloudCommands.js';
import { SelfHostedCommands } from '../commands/self-hosted/SelfHostedCommands.js';
import { WorkersCommands } from '../commands/workers/WorkersCommands.js';
import { GpuCommands } from '../commands/gpu/GpuCommands.js';
import { ConfigCommands } from '../commands/config/ConfigCommands.js';
import { ConsentCommands } from '../commands/consent/ConsentCommands.js';
import { SetupCommand } from '../commands/setup/SetupCommand.js';
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

// Simulates a fresh install: no API key, no consent token, nothing configured.
// Any network call during routing fails the test.
const withFreshInstall = async (fn: () => Promise<void>): Promise<void> => {
  const originalReadState = MswarmConfigStore.prototype.readState;
  const originalFetch = globalThis.fetch;
  (MswarmConfigStore.prototype as any).readState = async () => ({});
  (globalThis as any).fetch = async (input: unknown) => {
    throw new Error(`unexpected network call: ${String(input)}`);
  };
  try {
    await fn();
  } finally {
    (MswarmConfigStore.prototype as any).readState = originalReadState;
    globalThis.fetch = originalFetch;
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

test('McodaEntrypoint no-command usage mentions self-hosted setup', async () => {
  await assert.rejects(
    () => McodaEntrypoint.run([]),
    /Expose this machine: install `@mcoda\/mswarm`, then run `mswarm node install <CLIENTS>`/
  );
});

test(
  'McodaEntrypoint top-level help aliases print usage without reading config',
  { concurrency: false },
  async () => {
    const originalReadState = MswarmConfigStore.prototype.readState;
    (MswarmConfigStore.prototype as any).readState = async () => {
      throw new Error('config should not be read for help');
    };
    try {
      for (const alias of ['--help', '-h', '-H', 'help']) {
        const logs = await captureLogs(() => McodaEntrypoint.run([alias]));
        const output = logs.join('\n');
        assert.match(output, /^Usage: mcoda /);
        assert.ok(output.includes('Help: use `mcoda help`'));
        assert.ok(output.includes('Job commands (mcoda job --help for details)'));
      }
    } finally {
      (MswarmConfigStore.prototype as any).readState = originalReadState;
    }
  }
);

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
      withFreshInstall(
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
      withFreshInstall(
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
    await withFreshInstall(
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
      await withFreshInstall(
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
      await withFreshInstall(
        () => McodaEntrypoint.run(['cloud', 'agent', 'list', '--json'])
      );
      assert.equal(called, true);
    } finally {
      (CloudCommands as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint routes self-hosted agent commands',
  { concurrency: false },
  async () => {
    const originalRun = SelfHostedCommands.run;
    let called = false;
    (SelfHostedCommands as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['agent', 'sync', '--json']);
    };
    try {
      await withFreshInstall(
        () => McodaEntrypoint.run(['self-hosted', 'agent', 'sync', '--json'])
      );
      assert.equal(called, true);
    } finally {
      (SelfHostedCommands as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint routes worker commands',
  { concurrency: false },
  async () => {
    const originalRun = WorkersCommands.run;
    let called = false;
    (WorkersCommands as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['list', '--json']);
    };
    try {
      await withFreshInstall(
        () => McodaEntrypoint.run(['workers', 'list', '--json'])
      );
      assert.equal(called, true);
    } finally {
      (WorkersCommands as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint routes gpu commands',
  { concurrency: false },
  async () => {
    const originalRun = GpuCommands.run;
    let called = false;
    (GpuCommands as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['list', '--json']);
    };
    try {
      await withFreshInstall(
        () => McodaEntrypoint.run(['gpu', 'list', '--json'])
      );
      assert.equal(called, true);
    } finally {
      (GpuCommands as any).run = originalRun;
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
  'McodaEntrypoint routes legacy consent command',
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
  'McodaEntrypoint routes setup',
  { concurrency: false },
  async () => {
    const originalRun = SetupCommand.run;
    let called = false;
    (SetupCommand as any).run = async (argv: string[]) => {
      called = true;
      assert.deepEqual(argv, ['--json']);
    };
    try {
      await McodaEntrypoint.run(['setup', '--json']);
      assert.equal(called, true);
    } finally {
      (SetupCommand as any).run = originalRun;
    }
  }
);

test(
  'McodaEntrypoint never gates commands on telemetry consent',
  { concurrency: false },
  async () => {
    const originalRun = CloudCommands.run;
    let called = false;
    (CloudCommands as any).run = async () => {
      called = true;
    };
    const originalReadState = MswarmConfigStore.prototype.readState;
    let configRead = false;
    (MswarmConfigStore.prototype as any).readState = async () => {
      configRead = true;
      return { consentAccepted: false, consentToken: undefined };
    };
    try {
      await McodaEntrypoint.run(['cloud', 'agent', 'list', '--json']);
      assert.equal(called, true);
      assert.equal(configRead, false, 'entrypoint must not read consent state');
    } finally {
      (CloudCommands as any).run = originalRun;
      (MswarmConfigStore.prototype as any).readState = originalReadState;
    }
  }
);

test('McodaEntrypoint usage no longer mentions mandatory consent', async () => {
  const logs = await captureLogs(() => McodaEntrypoint.run(['--help']));
  const output = logs.join('\n');
  assert.doesNotMatch(output, /consent is required|mandatory mswarm telemetry consent|consent accept/i);
  assert.match(output, /Setup: none required/);
});

test('mcoda package has no install-time consent hook', () => {
  const pkg = packageJson as { scripts?: Record<string, string>; files?: string[] };
  assert.equal(pkg.scripts?.postinstall, undefined);
  assert.equal(pkg.scripts?.preinstall, undefined);
  assert.equal(pkg.scripts?.install, undefined);
  assert.ok(!(pkg.files ?? []).includes('MSWARM_DATA_COLLECTION_TERMS.md'));
});

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
      await withFreshInstall(
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
      await withFreshInstall(
        () => McodaEntrypoint.run(['sds', '--project', 'ABC'])
      );
      assert.equal(called, true);
    } finally {
      (DocsCommands as any).run = originalRun;
    }
  }
);
