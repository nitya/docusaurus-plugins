import type {Plugin} from '@docusaurus/types';

export default function themeCodeSandboxButton(): Plugin<void> {
  return {
    name: '@rise4fun/docusaurus-theme-side-editor',

    getThemePath() {
      return '../lib/theme';
    },
    getTypeScriptThemePath() {
      return '../src/theme';
    },
  };
}

export function getSwizzleComponentList() {
  return undefined
}