import { isAbsolute, relative } from 'pathe'
import { genDynamicImport } from 'knitwork'
import type { NuxtPluginTemplate, NuxtTemplate } from 'nuxt/schema'

type ImportMagicCommentsOptions = {
  chunkName: string
  prefetch?: boolean | number
  preload?: boolean | number
}

const createImportMagicComments = (options: ImportMagicCommentsOptions) => {
  const { chunkName, prefetch, preload } = options
  return [
    `webpackChunkName: "${chunkName}"`,
    prefetch === true || typeof prefetch === 'number' ? `webpackPrefetch: ${prefetch}` : false,
    preload === true || typeof preload === 'number' ? `webpackPreload: ${preload}` : false,
  ].filter(Boolean).join(', ')
}

const emptyComponentsPlugin = `
import { defineNuxtPlugin } from '#app/nuxt'
export default defineNuxtPlugin({
  name: 'nuxt:global-components',
})
`

export const componentsPluginTemplate: NuxtPluginTemplate = {
  filename: 'components.plugin.mjs',
  getContents ({ app }) {
    const lazyGlobalComponents = new Set<string>()
    const syncGlobalComponents = new Set<string>()
    for (const component of app.components) {
      if (component.global === 'sync') {
        syncGlobalComponents.add(component.pascalName)
      } else if (component.global) {
        lazyGlobalComponents.add(component.pascalName)
      }
    }
    if (!lazyGlobalComponents.size && !syncGlobalComponents.size) { return emptyComponentsPlugin }

    const lazyComponents = [...lazyGlobalComponents]
    const syncComponents = [...syncGlobalComponents]

    return `import { defineNuxtPlugin } from '#app/nuxt'
import { ${[...lazyComponents.map(c => 'Lazy' + c), ...syncComponents].join(', ')} } from '#components'
const lazyGlobalComponents = [
  ${lazyComponents.map(c => `["${c}", Lazy${c}]`).join(',\n')},
  ${syncComponents.map(c => `["${c}", ${c}]`).join(',\n')}
]

export default defineNuxtPlugin({
  name: 'nuxt:global-components',
  setup (nuxtApp) {
    for (const [name, component] of lazyGlobalComponents) {
      nuxtApp.vueApp.component(name, component)
      nuxtApp.vueApp.component('Lazy' + name, component)
    }
  }
})
`
  },
}

export const componentNamesTemplate: NuxtTemplate = {
  filename: 'component-names.mjs',
  getContents ({ app }) {
    return `export const componentNames = ${JSON.stringify(app.components.filter(c => !c.island).map(c => c.pascalName))}`
  },
}

export const componentsIslandsTemplate: NuxtTemplate = {
  // components.islands.mjs'
  getContents ({ app }) {
    const components = app.components
    const pages = app.pages
    const islands = components.filter(component =>
      component.island ||
      // .server components without a corresponding .client component will need to be rendered as an island
      (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client')),
    )
    const pageExports: string[] = []
    if (pages?.length) {
      for (const p of pages) {
        if (p.mode === 'server' && p.file && p.name) {
          pageExports.push(`"page:${p.name}": defineAsyncComponent(${genDynamicImport(p.file!)}.then(c => c.default || c))`)
        }
      }
    }

    return [
      'import { defineAsyncComponent } from \'vue\'',
      'export const islandComponents = import.meta.client ? {} : {',
      islands.map(
        (c) => {
          const exp = c.export === 'default' ? 'c.default || c' : `c['${c.export}']`
          const comment = createImportMagicComments(c)
          return `  "${c.pascalName}": defineAsyncComponent(${genDynamicImport(c.filePath, { comment })}.then(c => ${exp}))`
        },
      ).concat(pageExports).join(',\n'),
      '}',
    ].join('\n')
  },
}

export const componentsTypeTemplate = {
  filename: 'components.d.ts' as const,
  getContents: ({ app, nuxt }) => {
    const buildDir = nuxt.options.buildDir
    const componentTypes: [string, string][] = []
    for (const c of app.components){
      if (!c.island) {
        const type = `typeof ${genDynamicImport((isAbsolute(c.filePath) ? relative(buildDir, c.filePath) : c.filePath)
          .replace(/\b\.(?!vue)\w+$/g, ''), { wrapper: false })}['${c.export}']`
        componentTypes.push([
          c.pascalName,
          c.island || c.mode === 'server' ? `IslandComponent<${type}>` : type,
        ])
      }
    }

    const islandType = 'type IslandComponent<T extends DefineComponent> = T & DefineComponent<{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, SlotsType<{ fallback: { error: unknown } }>>'
    const syncComponents: string[] = []
    const asyncComponents: string[] = []
    for (const [pascalName, type] of componentTypes) {
      syncComponents.push(`'${pascalName}': ${type}`)
      asyncComponents.push(`'Lazy${pascalName}': ${type}`)
    }
    return `
import type { DefineComponent, SlotsType } from 'vue'
${nuxt.options.experimental.componentIslands ? islandType : ''}
interface _GlobalComponents {
      ${syncComponents.join('\n    ')}
      ${asyncComponents.join('\n    ')}
}

declare module '@vue/runtime-core' {
  export interface GlobalComponents extends _GlobalComponents { }
}

declare module '@vue/runtime-dom' {
  export interface GlobalComponents extends _GlobalComponents { }
}

declare module 'vue' {
  export interface GlobalComponents extends _GlobalComponents { }
}

export const ${syncComponents.join('\nexport const')}
export const ${asyncComponents.join('\nexport const')}

export const componentNames: string[]
`
  },
} satisfies NuxtTemplate

export const componentsMetadataTemplate: NuxtTemplate = {
  filename: 'components.json',
  write: true,
  getContents: ({ app }) => JSON.stringify(app.components, null, 2),
}
