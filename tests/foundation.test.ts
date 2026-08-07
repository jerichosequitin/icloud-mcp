import { describe, expect, test } from 'bun:test';

type PackageManifest = {
  packageManager?: string;
  scripts?: Record<string, string>;
};

describe('quality foundation', () => {
  test('exposes the documented quality commands', async () => {
    const packageFile = Bun.file(new URL('../package.json', import.meta.url));
    const manifest = (await packageFile.json()) as PackageManifest;

    expect(manifest.packageManager).toBe('bun@1.3.14');
    expect(manifest.scripts).toMatchObject({
      'format:check': 'prettier --check .',
      lint: 'eslint .',
      test: 'bun test',
      typecheck: 'tsc --noEmit',
    });
  });
});
