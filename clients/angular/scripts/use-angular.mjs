#!/usr/bin/env node
// Points the workspace at another Angular major, to test the package against it:
//
//   node scripts/use-angular.mjs 22 && npm install && npm test && npm run check:packaged
//
// Rewrites package.json only (the toolchain each major needs: TypeScript, Vitest, ng-packagr).
// The committed package.json and lock file stay on Angular 20, the oldest supported major,
// which is what the published package is built with.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOOLCHAINS = {
  20: { angular: '~20.3.0', typescript: '~5.9.2', vitest: '^3.2.4', jsdom: '^26.1.0' },
  21: { angular: '~21.2.0', typescript: '~5.9.2', vitest: '~4.0.8', jsdom: '^27.0.0' },
  22: { angular: '~22.2.0', typescript: '~6.0.2', vitest: '~4.0.8', jsdom: '^27.0.0' },
};

const major = process.argv[2];
const t = TOOLCHAINS[major];
if (!t) {
  console.error(`usage: use-angular.mjs <${Object.keys(TOOLCHAINS).join('|')}>`);
  process.exit(1);
}

const file = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(file, 'utf8'));
for (const deps of [pkg.dependencies, pkg.devDependencies]) {
  for (const name of Object.keys(deps)) {
    if (name.startsWith('@angular/') || name === 'ng-packagr') deps[name] = t.angular;
  }
}
pkg.devDependencies.typescript = t.typescript;
pkg.devDependencies.vitest = t.vitest;
pkg.devDependencies.jsdom = t.jsdom;
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package.json now uses Angular ${t.angular}, TypeScript ${t.typescript}, Vitest ${t.vitest}. Run npm install (not npm ci).`);
