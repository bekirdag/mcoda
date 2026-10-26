#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

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

export function canonicalJson(value) {
  const sort = item => {
    if (Array.isArray(item)) return item.map(sort);
    if (item === null || typeof item !== 'object') return item;
    // fromEntries preserves an own __proto__ key without changing prototypes.
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]));
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** Normalize pnpm's concurrently rewritten dependency-key order, preserving
 * every other tar entry byte. Only our newly generated package is rewritten. */
export function normalizePackedManifestArchive(compressed) {
  const archive = gunzipSync(compressed);
  const chunks = [];
  let offset = 0;
  let found = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error(`Invalid packed tar size for ${entryPath}`);
    const size = Number.parseInt(sizeText, 8);
    const end = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(end) || end > archive.length) throw new Error(`Truncated packed tar entry: ${entryPath}`);
    if (entryPath === 'package/package.json' || entryPath === 'package.json') {
      if (found || ![0, 48].includes(header[156])) throw new Error('Packed manifest must be one regular file');
      found = true;
      const value = JSON.parse(archive.subarray(offset + 512, offset + 512 + size).toString('utf8'));
      const content = Buffer.from(canonicalJson(value));
      const nextHeader = Buffer.from(header);
      nextHeader.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
      nextHeader.fill(32, 148, 156);
      const checksum = nextHeader.reduce((sum, byte) => sum + byte, 0);
      nextHeader.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
      chunks.push(nextHeader, content, Buffer.alloc((512 - content.length % 512) % 512));
    } else {
      chunks.push(archive.subarray(offset, end));
    }
    offset = end;
  }
  if (!found) throw new Error('Packed archive has no package.json');
  chunks.push(archive.subarray(offset));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
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
  return readPackedJsonFile(tarballPath, ['package/package.json', 'package.json']);
}

export function readPackedJsonFile(tarballPath, memberPath) {
  const memberPaths = Array.isArray(memberPath) ? memberPath : [memberPath];
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
    if (contentEnd > archive.length) throw new Error(`${tarballPath} contains a truncated tar entry`);
    if (memberPaths.includes(entryPath)) {
      return JSON.parse(
        archive.subarray(contentStart, contentEnd).toString('utf8')
      );
    }

    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  throw new Error(`${tarballPath} does not contain ${memberPath}`);
}

const archiveHash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

export function writePackedArtifactManifest(packages, dest) {
  const manifest = { schemaVersion: 1, revision: process.env.GITHUB_SHA ?? null,
    packages: packages.map(pkg => ({ name: pkg.manifest.name, version: pkg.manifest.version,
      filename: path.basename(pkg.tarballPath), sha256: archiveHash(pkg.tarballPath) })) };
  writeFileSync(path.join(dest, 'package-artifacts.json'), canonicalJson(manifest));
  return manifest;
}

/** Consume the exact bundle qualified by CI. Never normalize or rebuild it. */
export function loadPackedTarballs({ root = process.cwd(), dest, packageDirs = PACKAGE_DIRS, workspacePackageDirs = PACKAGE_DIRS, expectedRevision = process.env.GITHUB_SHA } = {}) {
  if (!dest) throw new Error('A qualified artifact directory is required');
  const metadata = JSON.parse(readFileSync(path.join(dest, 'package-artifacts.json'), 'utf8'));
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.packages)) throw new Error('Invalid package artifact manifest');
  if (expectedRevision && metadata.revision !== expectedRevision) throw new Error('Package artifact source revision does not match this checkout');
  const entries = new Map();
  for (const entry of metadata.packages) {
    if (!entry || typeof entry.name !== 'string' || entries.has(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error('Invalid/duplicate package artifact entry');
    entries.set(entry.name, entry);
  }
  const sources = workspacePackageDirs.map(dir => JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')));
  const internalVersions = new Map(sources.map(pkg => [pkg.name, pkg.version]));
  return packageDirs.map(packageDir => {
    const sourceManifest = JSON.parse(readFileSync(path.join(root, packageDir, 'package.json'), 'utf8'));
    const entry = entries.get(sourceManifest.name);
    const filename = packageTarballFilename(sourceManifest);
    if (!entry || entry.version !== sourceManifest.version || entry.filename !== filename) throw new Error(`Missing/mismatched qualified artifact for ${sourceManifest.name}`);
    const tarballPath = path.resolve(dest, filename);
    const info = lstatSync(tarballPath);
    if (!info.isFile() || info.isSymbolicLink() || archiveHash(tarballPath) !== entry.sha256) throw new Error(`Qualified artifact checksum mismatch: ${sourceManifest.name}`);
    const manifest = readPackedPackageJson(tarballPath);
    assertPackedManifestPortable({ sourceManifest, packedManifest: manifest, internalVersions, tarballPath });
    return { packageDir, tarballPath, manifest };
  });
}

export function packTarballs({
  root = process.cwd(),
  dest = path.join(root, 'artifacts'),
  packageDirs = PACKAGE_DIRS,
  workspacePackageDirs = PACKAGE_DIRS,
  pnpmCommand = resolvePnpmCommand(),
  execFile = execFileSync,
} = {}) {
  dest = path.resolve(dest);
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
    writeFileSync(tarballPath, normalizePackedManifestArchive(readFileSync(tarballPath)));
    const packedManifest = readPackedPackageJson(tarballPath);
    assertPackedManifestPortable({
      sourceManifest: manifest,
      packedManifest,
      internalVersions,
      tarballPath,
    });
    results.push({ packageDir, tarballPath, manifest: packedManifest });
  }

  writePackedArtifactManifest(results, dest);
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
