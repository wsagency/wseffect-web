/** Gallery provenance selections and adaptation scope approved by the owner for wseffect v0.1.0-rc.1. Build-time docs consume this mapping, never the source repository. */
export type GalleryMapping = {
  readonly id: string
  readonly sourceUrl: string
  readonly demoRoute: string
  readonly description: string
}

export const galleryMappings: ReadonlyArray<GalleryMapping> = [
  {
    id: 'controls',
    sourceUrl: 'https://github.com/wsagency/wseffect/blob/v0.1.0-rc.1/apps/gallery/src/pages/textField.ts',
    demoRoute: '/demos/#controls-title',
    description: 'Upstream TextField page has an empty Model and no validation; this site adaptation reflects the typed input value in the UI and still adds no validation.',
  },
  {
    id: 'select',
    sourceUrl: 'https://github.com/wsagency/wseffect/blob/v0.1.0-rc.1/apps/gallery/src/pages/select.ts',
    demoRoute: '/demos/#select-title',
    description: 'Select page demonstrating option selection and popup interaction.',
  },
  {
    id: 'dialog',
    sourceUrl: 'https://github.com/wsagency/wseffect/blob/v0.1.0-rc.1/apps/gallery/src/pages/dialog.ts',
    demoRoute: '/demos/#dialog-title',
    description: 'Dialog trigger, open state, and close/action flow.',
  },
  {
    id: 'tabs',
    sourceUrl: 'https://github.com/wsagency/wseffect/blob/v0.1.0-rc.1/apps/gallery/src/pages/tabs.ts',
    demoRoute: '/demos/#tabs-title',
    description: 'Tabs selection and associated panel presentation.',
  },
  {
    id: 'data-table',
    sourceUrl: 'https://github.com/wsagency/wseffect/blob/v0.1.0-rc.1/apps/gallery/src/pages/dataTable.ts',
    demoRoute: '/demos/#data-table-title',
    description: 'Upstream Gallery source uses 10,000 rows and filtering; this site adaptation uses three rows and demonstrates filtering, sorting, and selection.',
  },
  {
    id: 'theme',
    sourceUrl: 'https://github.com/wsagency/wseffect/blob/v0.1.0-rc.1/apps/gallery/src/pages/theme.ts',
    demoRoute: '/demos/#theme-title',
    description: 'Theme settings and appearance controls for the Gallery shell.',
  },
]
