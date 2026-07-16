#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const PACKAGE_DIRS = [
  'packages/shared',
  'packages/db',
  'packages/agents',
  'packages/generators',
  'packages/integrations',
  'packages/core',
  'packages/agent-setup',
  'packages/cli',
  'packages/codali',
  'packages/mswarm',
];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

export function getPnpmCandidates(platform = process.platform) {
  return platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm'];
}

export function resolvePnpmCommand({
  platform = process.platform,
  env = process.env,
  execFile = execFileSync,
} = {}) {
  let lastError;
  for (const candidate of getPnpmCandidates(platform)) {
    const command =
      platform === 'win32' && candidate.toLowerCase().endsWith('.cmd')
        ? {
            bin: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
            prefixArgs: ['/d', '/s', '/c', candidate],
          }
        : { bin: candidate, prefixArgs: [] };
    try {
      execFile(command.bin, command.prefixArgs.concat('--version'), {
        stdio: 'ignore',
      });
      return command;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    'pnpm not found on PATH; install pnpm before packaging npm tarballs.',
    {
      cause: lastError,
    }
  );
}

export function packageTarballFilename(manifest) {
  const normalizedName = manifest.name.replace(/^@/, '').replaceAll('/', '-');
  return `${normalizedName}-${manifest.version}.tgz`;
}

export function findWorkspaceProtocolPaths(value, currentPath = []) {
  if (typeof value === 'string') {
    return value.startsWith('workspace:') ? [currentPath.join('.')] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findWorkspaceProtocolPaths(entry, currentPath.concat(String(index)))
    );
  }
  if (value == null || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    findWorkspaceProtocolPaths(entry, currentPath.concat(key))
  );
}

export function expectedPackedWorkspaceRange(workspaceRange, version) {
  if (workspaceRange === 'workspace:*') return version;
  if (workspaceRange === 'workspace:^') return `^${version}`;
  if (workspaceRange === 'workspace:~') return `~${version}`;
  return workspaceRange.slice('workspace:'.length);
}

export function assertPackedManifestPortable({
  sourceManifest,
  packedManifest,
  internalVersions,
  tarballPath,
}) {
  const workspacePaths = findWorkspaceProtocolPaths(packedManifest);
  if (workspacePaths.length > 0) {
    throw new Error(
      `${tarballPath} contains non-portable workspace protocols at: ${workspacePaths.join(', ')}`
    );
  }

  if (
    packedManifest.name !== sourceManifest.name ||
    packedManifest.version !== sourceManifest.version
  ) {
    throw new Error(
      `${tarballPath} manifest identity mismatch: expected ${sourceManifest.name}@${sourceManifest.version}, ` +
        `received ${packedManifest.name}@${packedManifest.version}`
    );
  }

  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependencyName, sourceRange] of Object.entries(
      sourceManifest[field] ?? {}
    )) {
      if (!sourceRange.startsWith('workspace:')) continue;
      const dependencyVersion = internalVersions.get(dependencyName);
      if (!dependencyVersion) {
        throw new Error(
          `${sourceManifest.name} references unknown workspace dependency ${dependencyName} in ${field}`
        );
      }
      const expectedRange = expectedPackedWorkspaceRange(
        sourceRange,
        dependencyVersion
      );
      const packedRange = packedManifest[field]?.[dependencyName];
      if (packedRange !== expectedRange) {
        throw new Error(
          `${tarballPath} did not rewrite ${field}.${dependencyName}: expected ${expectedRange}, ` +
            `received ${String(packedRange)}`
        );
      }
    }
  }
}

export function readPackedPackageJson(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(
        `${tarballPath} contains an invalid tar entry size for ${entryPath}`
      );
    }

    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (entryPath === 'package/package.json' || entryPath === 'package.json') {
      return JSON.parse(
        archive.subarray(contentStart, contentEnd).toString('utf8')
      );
    }

    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  throw new Error(`${tarballPath} does not contain package/package.json`);
}

export function packTarballs({
  root = process.cwd(),
  dest = path.join(root, 'artifacts'),
  packageDirs = PACKAGE_DIRS,
  workspacePackageDirs = PACKAGE_DIRS,
  pnpmCommand = resolvePnpmCommand(),
  execFile = execFileSync,
} = {}) {
  mkdirSync(dest, { recursive: true });

  const workspacePackages = workspacePackageDirs.map((packageDir) => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, packageDir, 'package.json'), 'utf8')
    );
    return { packageDir, manifest };
  });
  const internalVersions = new Map(
    workspacePackages.map(({ manifest }) => [manifest.name, manifest.version])
  );
  const packages = packageDirs.map((packageDir) => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, packageDir, 'package.json'), 'utf8')
    );
    return { packageDir, manifest };
  });
  const results = [];
  const command =
    typeof pnpmCommand === 'string'
      ? { bin: pnpmCommand, prefixArgs: [] }
      : pnpmCommand;

  for (const { packageDir, manifest } of packages) {
    execFile(
      command.bin,
      command.prefixArgs.concat('pack', '--pack-destination', dest, '--json'),
      {
        cwd: path.join(root, packageDir),
        stdio: 'inherit',
        env: {
          ...process.env,
          npm_config_ignore_scripts: 'true',
        },
      }
    );

    const tarballPath = path.join(dest, packageTarballFilename(manifest));
    if (!existsSync(tarballPath)) {
      throw new Error(
        `pnpm pack did not create the expected tarball: ${tarballPath}`
      );
    }
    const packedManifest = readPackedPackageJson(tarballPath);
    assertPackedManifestPortable({
      sourceManifest: manifest,
      packedManifest,
      internalVersions,
      tarballPath,
    });
    results.push({ packageDir, tarballPath, manifest: packedManifest });
  }

  return results;
}

function readTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, boundedEnd).toString('utf8').trim();
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return (
    path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
  );
}

if (isMainModule()) {
  packTarballs();
}
