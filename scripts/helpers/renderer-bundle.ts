/**
 * @file
 *
 * Bundles a module for Obsidian's renderer and loads it there as a script, for the performance tests.
 *
 * A callback sent to Obsidian cannot import, so code it needs beyond the plugin arrives as an IIFE bundle that
 * defines one global.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { evalInObsidian } from 'obsidian-integration-testing';

/**
 * What {@link loadRendererBundle} loads.
 */
export interface LoadRendererBundleParams {
  /**
   * The module to bundle.
   */
  readonly entryUrl: URL;
  /**
   * The global the bundle assigns its exports to.
   */
  readonly globalName: string;
  /**
   * The vault of the Obsidian instance to load it into.
   */
  readonly vaultPath: string;
}

/**
 * Bundles a module as an IIFE for the renderer. Node built-ins stay external, so the renderer's `require` loads them.
 *
 * @param entryUrl - The module to bundle.
 * @param globalName - The global the bundle assigns its exports to, if any.
 * @returns The bundle's code.
 */
export async function bundleForRenderer(entryUrl: URL, globalName?: string): Promise<string> {
  const result = await build({
    bundle: true,
    entryPoints: [fileURLToPath(entryUrl)],
    external: ['node:*'],
    format: 'iife',
    logLevel: 'silent',
    platform: 'browser',
    target: 'es2022',
    write: false,
    ...globalName && { globalName }
  });
  const code = result.outputFiles[0]?.text;
  if (!code) {
    throw new Error(`Bundling ${entryUrl.href} produced no output`);
  }
  return code;
}

/**
 * Bundles a module and runs it in the renderer as a script.
 *
 * @param params - The module, its global and the vault.
 * @returns A promise that resolves once the script has run.
 */
export async function loadRendererBundle(params: LoadRendererBundleParams): Promise<void> {
  const code = await bundleForRenderer(params.entryUrl, params.globalName);
  await evalInObsidian({
    async callback({ code: scriptCode, globalName }) {
      const url = URL.createObjectURL(new Blob([scriptCode], { type: 'text/javascript' }));
      try {
        await new Promise<void>((resolve, reject) => {
          const script = createEl('script');
          script.src = url;
          script.addEventListener('load', () => {
            resolve();
          });
          script.addEventListener('error', () => {
            reject(new Error('The bundle failed to load'));
          });
          document.head.append(script);
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      if (Reflect.get(window, globalName) === undefined) {
        throw new Error(`The bundle did not define ${globalName}`);
      }
    },
    input: { code, globalName: params.globalName },
    vaultPath: params.vaultPath
  });
}
