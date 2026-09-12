/**
 * Reading what is already on the canvas.
 *
 * Phase 1 has `plainText` and the record collection the lint pass needs.
 * `describe` (the full `inspect` structure) is phase 2 and lands here.
 */

import {
  renderPlaintextFromRichText,
  type Editor,
  type TLRichText,
  type TLShape,
} from "tldraw";

import type { LintBinding, LintShape } from "./lints.js";
import { toShapeId, type ShapeKey } from "./ids.js";

function richTextOf(shape: TLShape): TLRichText | undefined {
  const props: unknown = shape.props;
  if (typeof props !== "object" || props === null) return undefined;
  const richText = (props as { richText?: unknown }).richText;
  return richText === undefined ? undefined : (richText as TLRichText);
}

/**
 * The visible text of a shape, read from its rich text.
 *
 * Use this rather than reaching into `props.richText`, which is a ProseMirror
 * document and not a string. A shape with no text at all answers `''`.
 *
 * @example
 * helpers.plainText('agent')   // 'agent cli'
 */
export function plainTextOf(editor: Editor, shape: ShapeKey | TLShape): string {
  const record = typeof shape === "string" ? editor.getShape(toShapeId(shape)) : shape;
  if (!record) return "";
  const richText = richTextOf(record);
  if (!richText) return "";
  return renderPlaintextFromRichText(editor, richText);
}

/**
 * Everything on the current page, reduced to the plain records the lint rules
 * take. This is the one place the live editor is turned into lintable data,
 * which is what keeps `lints.ts` free of any tldraw import.
 */
export function collectLintRecords(editor: Editor): {
  shapes: LintShape[];
  bindings: LintBinding[];
} {
  const pageShapes = editor.getCurrentPageShapes();
  const shapes: LintShape[] = pageShapes.map((shape) => ({
    id: shape.id,
    type: shape.type,
    meta: shape.meta,
  }));

  const bindings: LintBinding[] = [];
  for (const shape of pageShapes) {
    if (shape.type !== "arrow") continue;
    for (const binding of editor.getBindingsFromShape(shape.id, "arrow")) {
      bindings.push({
        type: binding.type,
        fromId: binding.fromId,
        toId: binding.toId,
        props: { terminal: binding.props.terminal },
      });
    }
  }
  return { shapes, bindings };
}
