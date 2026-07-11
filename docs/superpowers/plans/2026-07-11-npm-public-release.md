# npm 公开发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Publish @pure-agent/core@0.1.0 and @pure-agent/cli@0.1.0 publicly so users can install the pure-agent command with npm install -g @pure-agent/cli.

**Architecture:** Publish Core first as the CLI runtime dependency, then publish CLI with @pure-agent/core set to ^0.1.0. Both tarballs whitelist only built artifacts, their README, and their MIT LICENSE; a local tarball install proves the dependency chain before npm credentials are used.

**Tech Stack:** Node.js 20+, npm registry, pnpm workspace, TypeScript strict, Vitest, Ink 6.

## Global Constraints

- Root package.json and @pure-agent/desktop stay private.
- Both published packages are version 0.1.0; the CLI dependency value is exactly ^0.1.0.
- LICENSE copyright is Copyright (c) 2026 Pure Agent contributors.
- Package Node engine is >=20 and publication access is public on the default npm registry.
- Set NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache for every npm operation. Never repair or change ~/.npm permissions.
- Stop on a publish failure. Never republish an existing version, alter the version to hide an error, or publish CLI before Core.
- Preserve the user-owned untracked docs/superpowers/plans/2026-07-10-implemented-core-documentation-and-contract-repair.md.

---

### Task 1: Create public package manifests and user-facing package files

**Files:**
- Create: LICENSE
- Create: packages/core/LICENSE
- Create: packages/cli/LICENSE
- Create: packages/core/README.md
- Create: packages/cli/README.md
- Create: packages/cli/src/__tests__/package-manifest.test.ts
- Modify: packages/core/package.json
- Modify: packages/cli/package.json
- Modify: pnpm-lock.yaml

**Interfaces:**
- Consumes: the workspace package versions and the repository https://github.com/supermanyqq/pure-agent.
- Produces: public npm metadata and an npm-resolvable CLI dependency on @pure-agent/core.
- User contract: npm install -g @pure-agent/cli provides pure-agent on Node 20 or newer.

- [ ] **Step 1: Write the failing manifest test**

Create packages/cli/src/__tests__/package-manifest.test.ts:

~~~ts
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
~~~

- [ ] **Step 2: Run the manifest test and verify it fails**

Run:

~~~bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/package-manifest.test.ts --reporter=verbose
~~~

Expected: FAIL because both manifests are private, have no publication metadata, and CLI still depends on workspace:*.

- [ ] **Step 3: Add exact public npm metadata**

Remove private from both package manifests and add these fields to each:

~~~json
{
  "license": "MIT",
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public" },
  "bugs": { "url": "https://github.com/supermanyqq/pure-agent/issues" },
  "homepage": "https://github.com/supermanyqq/pure-agent#readme"
}
~~~

Use these package-specific fields:

~~~json
{
  "name": "@pure-agent/core",
  "description": "Core runtime for Pure Agent.",
  "keywords": ["agent", "ai", "deepseek", "llm"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/supermanyqq/pure-agent.git",
    "directory": "packages/core"
  }
}
~~~

~~~json
{
  "name": "@pure-agent/cli",
  "description": "Interactive terminal AI agent powered by DeepSeek.",
  "types": "./dist/index.d.ts",
  "keywords": ["agent", "ai", "chat", "cli", "deepseek", "llm"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/supermanyqq/pure-agent.git",
    "directory": "packages/cli"
  }
}
~~~

Keep CLI bin.pure-agent as ./dist/index.js. Change only the CLI production dependency value to:

~~~json
"@pure-agent/core": "^0.1.0"
~~~

- [ ] **Step 4: Add identical MIT licenses and package documentation**

Create LICENSE, packages/core/LICENSE, and packages/cli/LICENSE with this exact text:

~~~text
MIT License

Copyright (c) 2026 Pure Agent contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
~~~

Create packages/cli/README.md with installation, requirements, secure first-run configuration, commands, and uninstall:

~~~~markdown
# Pure Agent CLI

An interactive terminal AI agent powered by DeepSeek.

## Requirements

- Node.js 20 or newer
- A DeepSeek API key

## Install

~~~bash
npm install -g @pure-agent/cli
~~~

## Configure and chat

~~~bash
pure-agent
~~~

At the prompt, run /config set api-key, paste the key into the hidden input, and press Enter.

## Session commands

- /model selects deepseek-v4-pro or deepseek-v4-flash.
- /effort selects off, low, medium, or high.
- /new clears the current conversation.
- /help lists available commands.

## Uninstall

~~~bash
npm uninstall -g @pure-agent/cli
~~~

## License

MIT. See [LICENSE](./LICENSE).
~~~~

Create packages/core/README.md with the title Pure Agent Core, a statement that it is the CLI runtime dependency rather than a stable standalone SDK, the CLI install command, the repository URL, and the same MIT link.

- [ ] **Step 5: Update the lockfile and verify the test passes**

Run:

~~~bash
pnpm install --lockfile-only
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/package-manifest.test.ts --reporter=verbose
pnpm --filter @pure-agent/cli typecheck
~~~

Expected: 2 tests PASS, the lockfile resolves the local matching Core workspace for development, and TypeScript reports no errors.

- [ ] **Step 6: Commit the publishable package metadata**

~~~bash
git add LICENSE packages/core/LICENSE packages/cli/LICENSE packages/core/README.md packages/cli/README.md packages/core/package.json packages/cli/package.json packages/cli/src/__tests__/package-manifest.test.ts pnpm-lock.yaml
git commit -m "feat(release): prepare public npm packages"
~~~

### Task 2: Exclude tests from dist and verify tarball boundaries

**Files:**
- Modify: packages/core/tsconfig.json
- Modify: packages/cli/tsconfig.json
- Modify: packages/core/package.json
- Modify: packages/cli/package.json

**Interfaces:**
- Consumes: tsc include src and the npm prepack lifecycle.
- Produces: dist without test output and a tarball containing only dist, README, LICENSE, and package.json.
- Verification contract: no packed path starts with src/ or .turbo/, contains /__tests__/, or ends with .tsbuildinfo.

- [ ] **Step 1: Record the failing tarball acceptance check**

Run:

~~~bash
export NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache
pnpm clean
pnpm build
npm pack --dry-run --ignore-scripts --json --workspace @pure-agent/core
npm pack --dry-run --ignore-scripts --json --workspace @pure-agent/cli
~~~

Expected: release acceptance FAILS because the current compiler includes dist/**/__tests__/**. This command must not publish or write a tarball.

- [ ] **Step 2: Add clean-build packaging rules**

Add this field to both package tsconfig.json files:

~~~json
"exclude": ["src/**/__tests__/**"]
~~~

Add this script to Core:

~~~json
"prepack": "pnpm run clean && pnpm run build"
~~~

Add this script to CLI:

~~~json
"prepack": "pnpm --filter @pure-agent/core run build && pnpm run clean && pnpm run build"
~~~

Do not disable declaration maps or source maps; the files whitelist controls package scope.

- [ ] **Step 3: Rebuild and make the tarball check pass**

Run:

~~~bash
export NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache
pnpm clean
pnpm build
core_pack=$(npm pack --dry-run --ignore-scripts --json --workspace @pure-agent/core)
cli_pack=$(npm pack --dry-run --ignore-scripts --json --workspace @pure-agent/cli)
CORE_PACK="$core_pack" CLI_PACK="$cli_pack" node --input-type=module -e '
const allowed = (path) => path === "package.json" || path === "README.md" || path === "LICENSE" || path.startsWith("dist/");
const forbidden = (path) => path.startsWith("src/") || path.startsWith(".turbo/") || path.includes("/__tests__/") || path.endsWith(".tsbuildinfo");
for (const output of [process.env.CORE_PACK, process.env.CLI_PACK]) {
  const packed = JSON.parse(output);
  const paths = packed[0].files.map((file) => file.path);
  if (!paths.includes("dist/index.js") || !paths.every(allowed) || paths.some(forbidden)) process.exitCode = 1;
}
'
~~~

Expected: exit 0. Every packed file is allowed, and no test, source, cache, or tsbuildinfo path appears.

- [ ] **Step 4: Run all affected verification**

Run:

~~~bash
pnpm --filter @pure-agent/core test
pnpm --filter @pure-agent/cli test
pnpm typecheck
pnpm build
~~~

Expected: both Vitest suites PASS and all Turbo typecheck/build tasks PASS.

- [ ] **Step 5: Commit package-content protections**

~~~bash
git add packages/core/tsconfig.json packages/cli/tsconfig.json packages/core/package.json packages/cli/package.json
git commit -m "fix(release): restrict npm package contents"
~~~

### Task 3: Install local tarballs and satisfy the npm publication gate

**Files:**
- Verify only: packages/core/package.json
- Verify only: packages/cli/package.json
- External state: npm authentication and @pure-agent organization membership

**Interfaces:**
- Consumes: clean local Core and CLI tarballs and an npm account with @pure-agent publication access.
- Produces: evidence that the CLI resolves Core after installation and that the npm account can publish the selected scope.

- [ ] **Step 1: Pack and install both local artifacts in a temporary prefix**

Run:

~~~bash
export NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache
pack_dir=$(mktemp -d /private/tmp/pure-agent-pack.XXXXXX)
install_dir=$(mktemp -d /private/tmp/pure-agent-install.XXXXXX)
npm pack --ignore-scripts --pack-destination "$pack_dir" --workspace @pure-agent/core
npm pack --ignore-scripts --pack-destination "$pack_dir" --workspace @pure-agent/cli
npm install --prefix "$install_dir" "$pack_dir/pure-agent-core-0.1.0.tgz"
npm install --prefix "$install_dir" "$pack_dir/pure-agent-cli-0.1.0.tgz"
test -x "$install_dir/node_modules/.bin/pure-agent"
cd "$install_dir"
node --input-type=module -e "await import('@pure-agent/core'); console.log('core resolved')"
~~~

Expected: exit 0 and core resolved. Do not alter the current system-wide npm link.

- [ ] **Step 2: Ask the user to authenticate directly with npm**

Ask the user to run this command in their own terminal and confirm when it completes:

~~~bash
NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache npm login --registry=https://registry.npmjs.org/
~~~

The user enters password, browser approval, and OTP only in the npm prompt. Never request or record any credential in chat, source, test output, or terminal logs.

- [ ] **Step 3: Verify the authenticated account and scope rights**

Run only after the user confirms login:

~~~bash
export NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache
npm whoami --registry=https://registry.npmjs.org/
npm org ls pure-agent --json
npm publish --dry-run --access public --workspace @pure-agent/core
npm publish --dry-run --access public --workspace @pure-agent/cli
~~~

Expected: whoami yields an account name, the organization listing includes it, and both dry-runs succeed without uploading. If scope membership, 2FA, or either dry-run fails, stop and report the exact failure.

### Task 4: Publish Core then CLI and verify registry installation

**Files:**
- External write only: npm registry @pure-agent/core@0.1.0
- External write only: npm registry @pure-agent/cli@0.1.0

**Interfaces:**
- Consumes: local verification evidence plus authenticated @pure-agent publisher permission.
- Produces: two publicly installable npm packages and a verified pure-agent global executable.

- [ ] **Step 1: Publish Core and read back its immutable version**

Run from packages/core:

~~~bash
export NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache
npm publish --access public --registry=https://registry.npmjs.org/
npm view @pure-agent/core@0.1.0 version --registry=https://registry.npmjs.org/
~~~

Expected: view prints 0.1.0. If either command fails, stop before publishing CLI.

- [ ] **Step 2: Publish CLI and read back its version and bin**

Run from packages/cli:

~~~bash
export NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache
npm publish --access public --registry=https://registry.npmjs.org/
npm view @pure-agent/cli@0.1.0 version bin --json --registry=https://registry.npmjs.org/
~~~

Expected: the result contains version 0.1.0 and bin.pure-agent equal to ./dist/index.js. If this fails after Core succeeded, report that partial external state and stop.

- [ ] **Step 3: Validate the public global installation in an isolated prefix**

Run:

~~~bash
export NPM_CONFIG_CACHE=/private/tmp/pure-agent-npm-cache
prefix_dir=$(mktemp -d /private/tmp/pure-agent-global.XXXXXX)
home_dir=$(mktemp -d /private/tmp/pure-agent-home.XXXXXX)
npm install --global --prefix "$prefix_dir" @pure-agent/cli@0.1.0 --registry=https://registry.npmjs.org/
test -x "$prefix_dir/bin/pure-agent"
env -u PURE_AGENT_API_KEY HOME="$home_dir" "$prefix_dir/bin/pure-agent"
~~~

Expected: Ink starts and displays API Key Required and the /config set api-key guide. Press Ctrl+C to exit. This temporary prefix must not modify the user’s current global link.

- [ ] **Step 4: Verify the final repository state**

Run:

~~~bash
git status --short
git log --oneline -4
~~~

Expected: all package-preparation work is committed; only the user-owned pre-existing untracked plan remains. Report both public package versions and the installation command.
