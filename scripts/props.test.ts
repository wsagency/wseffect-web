import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as Schema from 'effect/Schema';
import * as Themes from '@wsagency/wseffect-themes';
import { Props as ButtonProps } from '@wsagency/wseffect-themes/components/button';
import { Props as BoxProps } from '@wsagency/wseffect-themes/components/box';
import { collectPropsSchemas, propsRows } from './props.ts';
import { Props as TabNavProps } from '@wsagency/wseffect-themes/components/tab-nav';

describe('propsRows', () => {
  it('unwraps optional unions and exposes literal choices from Effect Schema AST', () => {
    const rows = propsRows(Schema.Struct({
      size: Schema.optional(Schema.Union([Schema.Literal('small'), Schema.Literal('large')])),
      requiredSize: Schema.Union([Schema.Literal('compact'), Schema.Literal('wide')]),
    }));
    assert.deepEqual(rows[0], { name: 'size', type: '"small" | "large"', required: false, choices: ['"small"', '"large"'] });
    assert.deepEqual(rows[1], { name: 'requiredSize', type: '"compact" | "wide"', required: true, choices: ['"compact"', '"wide"'] });
  });

  it('renders booleans and responsive object unions without inventing defaults', () => {
    const rows = propsRows(BoxProps);
    const buttonRows = propsRows(ButtonProps);
    const highContrast = buttonRows.find((row) => row.name === 'highContrast');
    const width = rows.find((row) => row.name === 'width');
    assert.ok(highContrast);
    assert.equal(highContrast.required, false);
    assert.equal(highContrast.type, 'boolean');
    assert.ok(width);
    assert.equal(width.type, 'string | Responsive<string>');
    assert.equal(width.description, undefined);
    assert.equal('default' in width, false);
  });
  it('preserves boolean and literal data in a real exported component schema', () => {
    const rows = propsRows(ButtonProps);
    assert.equal(rows.find((row) => row.name === 'disabled')?.type, 'boolean');
    assert.deepEqual(rows.find((row) => row.name === 'variant')?.choices, ['"classic"', '"solid"', '"soft"', '"surface"', '"outline"', '"ghost-offset"', '"ghost"']);
  });

  it('preserves nested object and array item constraints from public schemas', () => {
    const items = propsRows(TabNavProps).find((row) => row.name === 'items');
    assert.ok(items);
    assert.equal(items.required, true);
    assert.equal(items.type, 'Array<{ value: string; href: string; label: string }>');
  });

  it('renders unsupported public AST nodes visibly rather than guessing', () => {
    const unsupported = { ast: { _tag: 'Transformation' } };
    const rows = propsRows({ ast: { _tag: 'Objects', propertySignatures: [{ name: 'value', type: unsupported.ast }] } });
    assert.equal(rows[0]?.type, 'Unsupported<Transformation>');
  });
});

describe('collectPropsSchemas', () => {
  it('collects all component Props schemas and nested named subparts from published exports', () => {
    const schemas = collectPropsSchemas(Themes);
    assert.ok(schemas.some((schema) => schema.schemaName === 'Button.Props'));
    assert.ok(schemas.some((schema) => schema.schemaName === 'Callout.Root.Props'));
    assert.ok(schemas.some((schema) => schema.schemaName === 'Callout.Icon.Props'));
  });
});
