import { existsSync } from 'node:fs'
import { genArrayFromRaw, genDynamicImport, genExport, genImport, genObjectFromRawEntries, genSafeVariableName, genString } from 'knitwork'
import { isAbsolute, join, relative, resolve } from 'pathe'
import type { JSValue } from 'untyped'
import { generateTypes, resolveSchema } from 'untyped'
import escapeRE from 'escape-string-regexp'
import { hash } from 'ohash'
import { camelCase } from 'scule'
import { filename } from 'pathe/utils'
import type { NuxtTemplate } from 'nuxt/schema'

import { annotatePlugins, checkForCircularDependencies } from './app'

export const vueShim: NuxtTemplate = {
  filename: 'types/vue-shim.d.ts',
  getContents: ({ nuxt }) => {
    if (!nuxt.options.typescript.shim) {
      return ''
    }

    return `declare module '*.vue' {
  import { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}`
  },
}

// TODO: Use an alias
export const appComponentTemplate: NuxtTemplate = {
  filename: 'app-component.mjs',
  getContents: ctx => genExport(ctx.app.mainComponent!, ['default']),
}
// TODO: Use an alias
export const rootComponentTemplate: NuxtTemplate = {
  filename: 'root-component.mjs',
  // TODO: fix upstream in vite - this ensures that vite generates a module graph for islands
  // but should not be necessary (and has a warmup performance cost). See https://github.com/nuxt/nuxt/pull/24584.
  getContents: ctx => (ctx.nuxt.options.dev ? 'import \'#build/components.islands.mjs\';\n' : '') + genExport(ctx.app.rootComponent!, ['default']),
}
// TODO: Use an alias
export const errorComponentTemplate: NuxtTemplate = {
  filename: 'error-component.mjs',
  getContents: ctx => genExport(ctx.app.errorComponent!, ['default']),
}
// TODO: Use an alias
export const testComponentWrapperTemplate: NuxtTemplate = {
  filename: 'test-component-wrapper.mjs',
  getContents: ctx => genExport(resolve(ctx.nuxt.options.appDir, 'components/test-component-wrapper'), ['default']),
}

export const cssTemplate: NuxtTemplate = {
  filename: 'css.mjs',
  getContents: ctx => ctx.nuxt.options.css.map(i => genImport(i)).join('\n'),
}

export const clientPluginTemplate: NuxtTemplate = {
  filename: 'plugins/client.mjs',
  async getContents (ctx): Promise<string> {
    const clientPlugins = await annotatePlugins(ctx.nuxt, ctx.app.plugins.filter(p => !p.mode || p.mode !== 'server'))
    checkForCircularDependencies(clientPlugins)
    const exports: string[] = []
    const imports: string[] = []
    for (const plugin of clientPlugins) {
      const path = relative(ctx.nuxt.options.rootDir, plugin.src)
      const variable = genSafeVariableName(filename(plugin.src)).replace(/_(45|46|47)/g, '_') + '_' + hash(path)
      exports.push(variable)
      imports.push(genImport(plugin.src, variable))
    }
    return `${imports.join('\n')}
export default ${genArrayFromRaw(exports)}`
  },
}

export const serverPluginTemplate: NuxtTemplate = {
  filename: 'plugins/server.mjs',
  async getContents (ctx): Promise<string> {
    const serverPlugins = await annotatePlugins(ctx.nuxt, ctx.app.plugins.filter(p => !p.mode || p.mode !== 'client'))
    checkForCircularDependencies(serverPlugins)
    const exports: string[] = []
    const imports: string[] = []
    for (const plugin of serverPlugins) {
      const path = relative(ctx.nuxt.options.rootDir, plugin.src)
      const variable = genSafeVariableName(filename(path)).replace(/_(45|46|47)/g, '_') + '_' + hash(path)
      exports.push(variable)
      imports.push(genImport(plugin.src, variable))
    }
    return `${imports.join('\n')}
export default ${genArrayFromRaw(exports)}`
  },
}

export const pluginsDeclaration: NuxtTemplate = {
  filename: 'types/plugins.d.ts',
  getContents: async (ctx) => {
    const EXTENSION_RE = new RegExp(`(?<=\\w)(${ctx.nuxt.options.extensions.map(e => escapeRE(e)).join('|')})$`, 'g')
    const tsImports: string[] = []
    for (const p of ctx.app.plugins) {
      const sources = [p.src, p.src.replace(EXTENSION_RE, '.d.ts')]
      if (!isAbsolute(p.src)) {
        tsImports.push(p.src.replace(EXTENSION_RE, ''))
      } else if (ctx.app.templates.some(t => t.write && t.dst && (t.dst === sources[0] || t.dst === sources[1])) || sources.some(s => existsSync(s))) {
        tsImports.push(relative(join(ctx.nuxt.options.buildDir, 'types'), p.src).replace(EXTENSION_RE, ''))
      }
    }

    const pluginsName: string[] = []
    for (const p of await annotatePlugins(ctx.nuxt, ctx.app.plugins)) {
      if (p.name) {
        pluginsName.push(`'${p.name}'`)
      }
    }
    return `// Generated by Nuxt'
import type { Plugin } from '#app'

type Decorate<T extends Record<string, any>> = { [K in keyof T as K extends string ? \`$\${K}\` : never]: T[K] }

type IsAny<T> = 0 extends 1 & T ? true : false
type InjectionType<A extends Plugin> = IsAny<A> extends true ? unknown : A extends Plugin<infer T> ? Decorate<T> : unknown

type NuxtAppInjections = \n  ${tsImports.map(p => `InjectionType<typeof ${genDynamicImport(p, { wrapper: false })}.default>`).join(' &\n  ')}

declare module '#app' {
  interface NuxtApp extends NuxtAppInjections { }

  interface NuxtAppLiterals {
    pluginName: ${pluginsName.join(' | ')}
  }
}

declare module '#app/defaults' {
  type DefaultAsyncDataErrorValue = ${ctx.nuxt.options.future.compatibilityVersion === 4 ? 'undefined' : 'null'}
  type DefaultAsyncDataValue = ${ctx.nuxt.options.future.compatibilityVersion === 4 ? 'undefined' : 'null'}
  type DefaultErrorValue = ${ctx.nuxt.options.future.compatibilityVersion === 4 ? 'undefined' : 'null'}
}

declare module 'vue' {
  interface ComponentCustomProperties extends NuxtAppInjections { }
}

export { }
`
  },
}

const adHocModules = ['router', 'pages', 'imports', 'meta', 'components', 'nuxt-config-schema']
export const schemaTemplate: NuxtTemplate = {
  filename: 'types/schema.d.ts',
  getContents: async ({ nuxt }) => {
    const relativeRoot = relative(resolve(nuxt.options.buildDir, 'types'), nuxt.options.rootDir)
    const getImportName = (name: string) => (name[0] === '.' ? './' + join(relativeRoot, name) : name).replace(/\.\w+$/, '')
    const moduleInfoStr: string[] = []
    const modulesStr: string[] = []
    for (const m of nuxt.options._installedModules) {
      const meta = m.meta
      const impName = m.entryPath || meta?.name
      if (meta.configKey && meta.name && !adHocModules.includes(meta.name)) {
        const configKey = genString(meta.configKey)
        const importName = getImportName(impName)
        moduleInfoStr.push(` [${configKey}]?: typeof ${genDynamicImport(importName, { wrapper: false })}.default extends NuxtModule<infer O> ? Partial<O> : Record<string, any>`)
        modulesStr.push(`[${genString(importName)}, Exclude<NuxtConfig[${configKey}], boolean>]`)
      }
    }
    const privateRuntimeConfig = Object.create(null)
    for (const key in nuxt.options.runtimeConfig) {
      if (key !== 'public') {
        privateRuntimeConfig[key] = nuxt.options.runtimeConfig[key]
      }
    }
    return [
      'import { NuxtModule, RuntimeConfig } from \'nuxt/schema\'',
      'declare module \'nuxt/schema\' {',
      '  interface NuxtConfig {',
      moduleInfoStr.join('\n'),
      modulesStr.length ? `    modules?: (undefined | null | false | NuxtModule | string | [NuxtModule | string, Record<string, any>] | ${modulesStr.join(' | ')})[],` : '',
      '  }',
      generateTypes(await resolveSchema(privateRuntimeConfig as Record<string, JSValue>),
        {
          interfaceName: 'RuntimeConfig',
          addExport: false,
          addDefaults: false,
          allowExtraKeys: false,
          indentation: 2,
        }),
      generateTypes(await resolveSchema(nuxt.options.runtimeConfig.public as Record<string, JSValue>),
        {
          interfaceName: 'PublicRuntimeConfig',
          addExport: false,
          addDefaults: false,
          allowExtraKeys: false,
          indentation: 2,
        }),
      '}',
      `declare module 'vue' {
        interface ComponentCustomProperties {
          $config: RuntimeConfig
        }
      }`,
    ].join('\n')
  },
}

// Add layouts template
export const layoutTemplate: NuxtTemplate = {
  filename: 'layouts.mjs',
  getContents ({ app }) {
    const entries: [string, any][] = []
    for (const key in app.layouts) {
      const { name, file } = app.layouts[key]
      entries.push([name, genDynamicImport(file, { interopDefault: true })])
    }
    const layoutsObject = genObjectFromRawEntries(entries)
    return `export default ${layoutsObject}`
  },
}

// Add middleware template
export const middlewareTemplate: NuxtTemplate = {
  filename: 'middleware.mjs',
  getContents ({ app }): string {
    const globalMiddleware = []
    const namedMiddleware = []
    for (const mw of app.middleware) {
      if (mw.global) {
        globalMiddleware.push(mw)
      } else {
        namedMiddleware.push(mw)
      }
    }
    const namedMiddlewareObject = genObjectFromRawEntries(namedMiddleware.map(mw => [mw.name, genDynamicImport(mw.path)]))
    const globalMiddlewareObject = []
    const globalMiddlewareImport: string[] = []
    for (const mw of globalMiddleware) {
      const variableName = genSafeVariableName(mw.name)
      globalMiddlewareObject.push(variableName)
      globalMiddlewareImport.push(genImport(mw.path, variableName))
    }
    return `${globalMiddlewareImport.join('\n')}
export const globalMiddleware = ${genArrayFromRaw(globalMiddlewareObject)}
export const namedMiddleware = ${namedMiddlewareObject}`
  },
}

export const nitroSchemaTemplate: NuxtTemplate = {
  filename: 'types/nitro-nuxt.d.ts',
  getContents () {
    return /* typescript */`
/// <reference path="./schema.d.ts" />

import type { RuntimeConfig } from 'nuxt/schema'
import type { H3Event } from 'h3'
import type { LogObject } from 'consola'
import type { NuxtIslandContext, NuxtIslandResponse, NuxtRenderHTMLContext } from 'nuxt/app'

declare module 'nitropack' {
  interface NitroRuntimeConfigApp {
    buildAssetsDir: string
    cdnURL: string
  }
  interface NitroRuntimeConfig extends RuntimeConfig {}
  interface NitroRouteConfig {
    ssr?: boolean
    experimentalNoScripts?: boolean
  }
  interface NitroRouteRules {
    ssr?: boolean
    experimentalNoScripts?: boolean
    appMiddleware?: Record<string, boolean>
  }
  interface NitroRuntimeHooks {
    'dev:ssr-logs': (ctx: { logs: LogObject[], path: string }) => void | Promise<void>
    'render:html': (htmlContext: NuxtRenderHTMLContext, context: { event: H3Event }) => void | Promise<void>
    'render:island': (islandResponse: NuxtIslandResponse, context: { event: H3Event, islandContext: NuxtIslandContext }) => void | Promise<void>
  }
}
`
  },
}

export const clientConfigTemplate: NuxtTemplate = {
  filename: 'nitro.client.mjs',
  getContents: () => `
export const useRuntimeConfig = () => window?.__NUXT__?.config || {}
`,
}

export const appConfigDeclarationTemplate: NuxtTemplate = {
  filename: 'types/app.config.d.ts',
  getContents ({ app, nuxt }) {
    const typesDir = join(nuxt.options.buildDir, 'types')
    const configPaths = app.configs.map(path => relative(typesDir, path).replace(/\b\.\w+$/g, ''))

    return `
import type { CustomAppConfig } from 'nuxt/schema'
import type { Defu } from 'defu'
${configPaths.map((id: string, index: number) => `import ${`cfg${index}`} from ${JSON.stringify(id)}`).join('\n')}

declare const inlineConfig = ${JSON.stringify(nuxt.options.appConfig, null, 2)}
type ResolvedAppConfig = Defu<typeof inlineConfig, [${app.configs.map((_id: string, index: number) => `typeof cfg${index}`).join(', ')}]>
type IsAny<T> = 0 extends 1 & T ? true : false

type MergedAppConfig<Resolved extends Record<string, unknown>, Custom extends Record<string, unknown>> = {
  [K in keyof (Resolved & Custom)]: K extends keyof Custom
    ? unknown extends Custom[K]
      ? Resolved[K]
      : IsAny<Custom[K]> extends true
        ? Resolved[K]
        : Custom[K] extends Record<string, any>
            ? Resolved[K] extends Record<string, any>
              ? MergedAppConfig<Resolved[K], Custom[K]>
              : Exclude<Custom[K], undefined>
            : Exclude<Custom[K], undefined>
    : Resolved[K]
}

declare module 'nuxt/schema' {
  interface AppConfig extends MergedAppConfig<ResolvedAppConfig, CustomAppConfig> { }
}
declare module '@nuxt/schema' {
  interface AppConfig extends MergedAppConfig<ResolvedAppConfig, CustomAppConfig> { }
}
`
  },
}

export const appConfigTemplate: NuxtTemplate = {
  filename: 'app.config.mjs',
  write: true,
  getContents ({ app, nuxt }) {
    return `
import { updateAppConfig } from '#app/config'
import { defuFn } from 'defu'

const inlineConfig = ${JSON.stringify(nuxt.options.appConfig, null, 2)}

// Vite - webpack is handled directly in #app/config
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    updateAppConfig(newModule.default)
  })
}

${app.configs.map((id: string, index: number) => `import ${`cfg${index}`} from ${JSON.stringify(id)}`).join('\n')}

export default /*@__PURE__*/ defuFn(${app.configs.map((_id: string, index: number) => `cfg${index}`).concat(['inlineConfig']).join(', ')})
`
  },
}

export const publicPathTemplate: NuxtTemplate = {
  filename: 'paths.mjs',
  getContents ({ nuxt }) {
    return [
      'import { joinRelativeURL } from \'ufo\'',
      !nuxt.options.dev && 'import { useRuntimeConfig } from \'#internal/nitro\'',

      nuxt.options.dev
        ? `const appConfig = ${JSON.stringify(nuxt.options.app)}`
        : 'const appConfig = useRuntimeConfig().app',

      'export const baseURL = () => appConfig.baseURL',
      'export const buildAssetsDir = () => appConfig.buildAssetsDir',

      'export const buildAssetsURL = (...path) => joinRelativeURL(publicAssetsURL(), buildAssetsDir(), ...path)',

      'export const publicAssetsURL = (...path) => {',
      '  const publicBase = appConfig.cdnURL || appConfig.baseURL',
      '  return path.length ? joinRelativeURL(publicBase, ...path) : publicBase',
      '}',

      // On server these are registered directly in packages/nuxt/src/core/runtime/nitro/renderer.ts
      'if (import.meta.client) {',
      '  globalThis.__buildAssetsURL = buildAssetsURL',
      '  globalThis.__publicAssetsURL = publicAssetsURL',
      '}',
    ].filter(Boolean).join('\n')
  },
}

export const dollarFetchTemplate: NuxtTemplate = {
  filename: 'fetch.mjs',
  getContents () {
    return `import { $fetch } from 'ofetch'
import { baseURL } from '#internal/nuxt/paths'
if (!globalThis.$fetch) {
  globalThis.$fetch = $fetch.create({
    baseURL: baseURL()
  })
}`
  },
}

// Allow direct access to specific exposed nuxt.config
export const nuxtConfigTemplate: NuxtTemplate = {
  filename: 'nuxt.config.mjs',
  getContents: (ctx) => {
    const fetchDefaults = {
      ...ctx.nuxt.options.experimental.defaults.useFetch,
      baseURL: undefined,
      headers: undefined,
    }
    const shouldEnableComponentIslands = ctx.nuxt.options.experimental.componentIslands && (
      ctx.nuxt.options.dev || ctx.nuxt.options.experimental.componentIslands !== 'auto' || ctx.app.pages?.some(p => p.mode === 'server') || ctx.app.components?.some(c => c.mode === 'server' && !ctx.app.components.some(other => other.pascalName === c.pascalName && other.mode === 'client'))
    )
    const contents: string[] = []
    for (const k in ctx.nuxt.options.app) {
      contents.push(`export const ${camelCase('app-' + k)} = ${JSON.stringify(ctx.nuxt.options.app[k as keyof typeof ctx.nuxt.options.app])}`)
    }
    return `${contents.join('\n\n')}\n\n
export const renderJsonPayloads = ${!!ctx.nuxt.options.experimental.renderJsonPayloads}\n\n
export const componentIslands = ${shouldEnableComponentIslands}\n\n
export const payloadExtraction = ${!!ctx.nuxt.options.experimental.payloadExtraction}\n\n
export const cookieStore = ${!!ctx.nuxt.options.experimental.cookieStore}\n\n
export const appManifest = ${!!ctx.nuxt.options.experimental.appManifest}\n\n
export const remoteComponentIslands = ${typeof ctx.nuxt.options.experimental.componentIslands === 'object' && ctx.nuxt.options.experimental.componentIslands.remoteIsland}\n\n
export const selectiveClient = ${typeof ctx.nuxt.options.experimental.componentIslands === 'object' && Boolean(ctx.nuxt.options.experimental.componentIslands.selectiveClient)}\n\n
export const devPagesDir = ${ctx.nuxt.options.dev ? JSON.stringify(ctx.nuxt.options.dir.pages) : 'null'}\n\n
export const devRootDir = ${ctx.nuxt.options.dev ? JSON.stringify(ctx.nuxt.options.rootDir) : 'null'}\n\n
export const devLogs = ${JSON.stringify(ctx.nuxt.options.features.devLogs)}\n\n
export const nuxtLinkDefaults = ${JSON.stringify(ctx.nuxt.options.experimental.defaults.nuxtLink)}\n\n
export const asyncDataDefaults = ${JSON.stringify({
  ...ctx.nuxt.options.experimental.defaults.useAsyncData,
  value: ctx.nuxt.options.experimental.defaults.useAsyncData.value === 'null' ? null : undefined,
  errorValue: ctx.nuxt.options.experimental.defaults.useAsyncData.errorValue === 'null' ? null : undefined,
})}\n\n
export const resetAsyncDataToUndefined = ${ctx.nuxt.options.experimental.resetAsyncDataToUndefined}\n\n
export const nuxtDefaultErrorValue = ${ctx.nuxt.options.future.compatibilityVersion === 4 ? 'undefined' : 'null'}\n\n
export const fetchDefaults = ${JSON.stringify(fetchDefaults)}\n\n
export const vueAppRootContainer = ${ctx.nuxt.options.app.rootId ? `'#${ctx.nuxt.options.app.rootId}'` : `'body > ${ctx.nuxt.options.app.rootTag}'`}\n\n
export const viewTransition = ${ctx.nuxt.options.experimental.viewTransition}\n\n
export const appId = ${JSON.stringify(ctx.nuxt.options.appId)}`
  },
}

const TYPE_FILENAME_RE = /\.([cm])?[jt]s$/
const DECLARATION_RE = /\.d\.[cm]?ts$/
export const buildTypeTemplate: NuxtTemplate = {
  filename: 'types/build.d.ts',
  getContents ({ app }) {
    let declarations = ''

    for (const file of app.templates) {
      if (file.write || !file.filename || DECLARATION_RE.test(file.filename)) {
        continue
      }

      if (TYPE_FILENAME_RE.test(file.filename)) {
        const typeFilenames = new Set([file.filename.replace(TYPE_FILENAME_RE, '.d.$1ts'), file.filename.replace(TYPE_FILENAME_RE, '.d.ts')])
        if (app.templates.some(f => f.filename && typeFilenames.has(f.filename))) {
          continue
        }
      }

      declarations += 'declare module ' + JSON.stringify(join('#build', file.filename)) + ';\n'
    }

    return declarations
  },
}
