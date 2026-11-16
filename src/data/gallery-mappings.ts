/** Manually reviewed examples from the canonical Gallery source at wseffect v0.1.0-rc.1. Build-time docs consume this mapping, never the source repository. */
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
    description: 'TextField form example with controlled Model state and validation behavior.',
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
    description: 'Virtualized data table with filtering, sorting, and keyboard navigation.',
  },
  {
    id: 'theme',
    sourceUrl: 'https://github.com/wsagency/wseffect/blob/v0.1.0-rc.1/apps/gallery/src/pages/theme.ts',
    demoRoute: '/demos/#theme-title',
    description: 'Theme settings and appearance controls for the Gallery shell.',
  },
]
