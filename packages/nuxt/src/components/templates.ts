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
  getContents ({ app, nuxt }) {
    if (!nuxt.options.experimental.componentIslands) {
      return 'export const islandComponents = {}'
    }

    const components = app.components
    const pages = app.pages
    const islands = components.filter(component =>
      component.island ||
      // .server components without a corresponding .client component will need to be rendered as an island
      (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client')),
    )

    const pageExports = pages?.filter(p => (p.mode === 'server' && p.file && p.name)).map((p) => {
      return `"page:${p.name}": defineAsyncComponent(${genDynamicImport(p.file!)}.then(c => c.default || c))`
    }) || []

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

const NON_VUE_RE = /\b\.(?!vue)\w+$/g
export const componentsTypeTemplate = {
  filename: 'components.d.ts' as const,
  getContents: ({ app, nuxt }) => {
    const buildDir = nuxt.options.buildDir
    const componentTypes = app.components.filter(c => !c.island).map((c) => {
      const type = `typeof ${genDynamicImport(isAbsolute(c.filePath)
        ? relative(buildDir, c.filePath).replace(NON_VUE_RE, '')
        : c.filePath.replace(NON_VUE_RE, ''), { wrapper: false })}['${c.export}']`
      return [
        c.pascalName,
        c.island || c.mode === 'server' ? `IslandComponent<${type}>` : type,
      ]
    })

    const islandType = 'type IslandComponent<T extends DefineComponent> = T & DefineComponent<{}, {refresh: () => Promise<void>}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, SlotsType<{ fallback: { error: unknown } }>>'
    const components: string[] = new Array(componentTypes.length)
    const componentExports: string[] = new Array(componentTypes.length)
    for (let i = 0; i < componentTypes.length; i++) {
      const [pascalName, type] = componentTypes[i]!
      components[i] = `${pascalName}': ${type}`
      componentExports[i] = `${pascalName}: ${type}`
    }
    return `
import type { DefineComponent, SlotsType } from 'vue'
${nuxt.options.experimental.componentIslands ? islandType : ''}
interface _GlobalComponents {
    '${components.join('\n    \'')}
    'Lazy${components.join('\n    \'Lazy')}
}

declare module 'vue' {
  export interface GlobalComponents extends _GlobalComponents { }
}

export const ${componentExports.join('\nexport const ')}
export const Lazy${componentExports.join('\nexport const Lazy')}

export const componentNames: string[]
`
  },
} satisfies NuxtTemplate

export const componentsMetadataTemplate: NuxtTemplate = {
  filename: 'components.json',
  write: true,
  getContents: ({ app }) => JSON.stringify(app.components, null, 2),
}
