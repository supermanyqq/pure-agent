import { describe, expect, it } from 'vitest';
import cliManifest from '../../package.json';
import coreManifest from '../../../core/package.json';

interface PublishManifest {
  private?: boolean;
  license?: string;
  files?: string[];
  engines?: { node?: string };
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
}

const PUBLISHED_FILES = ['dist', 'README.md', 'LICENSE'];
const PUBLIC_ACCESS = 'public';
const REQUIRED_NODE_VERSION = '>=20';
const CORE_VERSION_RANGE = '^0.1.0';

describe('npm publication manifests', () => {
  it('declares Core and CLI as public Node 20 packages', () => {
    for (const manifest of [coreManifest, cliManifest] as PublishManifest[]) {
      expect(manifest.private).toBeUndefined();
      expect(manifest.license).toBe('MIT');
      expect(manifest.engines?.node).toBe(REQUIRED_NODE_VERSION);
      expect(manifest.publishConfig?.access).toBe(PUBLIC_ACCESS);
      expect(manifest.files).toEqual(PUBLISHED_FILES);
    }
  });

  it('uses a registry-resolvable Core version range from CLI', () => {
    expect(cliManifest.dependencies?.['@pure-agent/core']).toBe(CORE_VERSION_RANGE);
  });
});
