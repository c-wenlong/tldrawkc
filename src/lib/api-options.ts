/**
 * Each helper's option fields, read out of the page's TypeScript at build time.
 *
 * A signature says `opts?: BoxShapesOptions` and stops there, so an agent that
 * wants to know what goes in the object greps the source for the interface,
 * and one that guesses writes an option the helper ignores. This module puts
 * the fields into `dist/api.json` beside the signature: for every helper with
 * an `opts` parameter, the fields of the type it names, each with its type as
 * written, whether it is optional, its doc comment, and the default the code
 * applies when it is left out.
 *
 * Both halves come from the source, so neither can drift:
 *
 *   - **The fields** are the interface's own members plus what its `extends`
 *     clause brings in, with `Omit<...>` and `Pick<...>` applied. A name is
 *     resolved through the module's own imports, starting from
 *     `src/page/helpers/index.ts`, so `boxShapes as containerAround` and a type
 *     declared three files away both land on the declaration that runs.
 *   - **The defaults** are read from the code, not from the prose. Starting at
 *     the helper's own body, every `opts.field ?? fallback` is an observation,
 *     and every call that hands `opts` on is followed into the callee, under
 *     whatever name that callee gives the parameter. A fallback that evaluates
 *     to a constant (a literal, or a `const` that holds one, `DEFAULT_GAP` or
 *     `DEFAULT_BOX_SIZE.w`) is a default. A fallback that is not (`opts.color`,
 *     `first.box.x`) means the default depends on something else, and then the
 *     field carries no `default` and its doc comment says what it is. Two
 *     observations that disagree are the same case.
 *
 * This is the one module that needs the TypeScript compiler, and it needs only
 * its parser: nothing is type checked, so nothing has to resolve `tldraw`.
 * `typescript` is a devDependency, present wherever `npm run build` can run at
 * all, and absent from an install of the tool. So `buildApiReference` loads this
 * file with a dynamic `import()`, the `api` command only ever reads the JSON it
 * wrote, and `test/unit/layering.test.ts` fails a static import of this file
 * from anywhere under `src/`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import type { HelperDoc, HelperOptions, OptionDefault, OptionField, SourceFile } from "./api.js";

/** The parameter whose type is a helper's options. */
export const OPTIONS_PARAM = "opts";

/** One parsed module, keyed by the same package-relative path `SourceFile` uses. */
interface Module {
  path: string;
  file: ts.SourceFile;
}

/** A declaration found by name, and the module it sits in. */
interface Found<T extends ts.Node> {
  module: Module;
  node: T;
}

/** What one `opts.field ?? fallback` said about the field. */
type Observation = { constant: true; value: OptionDefault } | { constant: false };

/** How deep `evaluate` follows one constant into another before giving up. */
const MAX_EVALUATE_DEPTH = 16;

// ---------------------------------------------------------------------------
// Reading the modules
// ---------------------------------------------------------------------------

/**
 * Read the entry files and every module they import by a relative path.
 *
 * The graph is followed rather than listed, so a helper that starts delegating
 * to a new sibling file is covered without anyone updating a list. Bare
 * specifiers (`tldraw`) are not followed: nothing in them is ours to document.
 * A relative import that does not resolve to a file is skipped rather than
 * thrown on, and the lookup that needed it throws instead, by name.
 */
export async function readOptionSources(
  entries: readonly SourceFile[],
  root: string,
): Promise<SourceFile[]> {
  const byPath = new Map<string, SourceFile>();
  const queue = [...entries];
  while (queue.length > 0) {
    const source = queue.shift();
    if (source === undefined || byPath.has(source.path)) continue;
    byPath.set(source.path, source);
    for (const specifier of relativeImportsOf(source.text)) {
      const target = resolveSpecifier(source.path, specifier);
      if (byPath.has(target)) continue;
      try {
        queue.push({ path: target, text: await fs.readFile(path.join(root, target), "utf8") });
      } catch {
        // Not a file of ours, or not a `.ts` one. See the comment above.
      }
    }
  }
  return [...byPath.values()];
}

/** Every `./` or `../` module specifier in a file, imports and re-exports alike. */
function relativeImportsOf(text: string): string[] {
  const file = ts.createSourceFile("scan.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: string[] = [];
  for (const statement of file.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      found.push(statement.moduleSpecifier.text);
    }
  }
  return found;
}

/**
 * `./shapes.js` imported from `src/page/helpers/index.ts` is
 * `src/page/helpers/shapes.ts`. The page is compiled with NodeNext-style
 * specifiers, so the source of a `.js` import is the `.ts` beside it.
 */
function resolveSpecifier(from: string, specifier: string): string {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return joined.replace(/\.js$/u, ".ts");
}

// ---------------------------------------------------------------------------
// Attaching options to the reference
// ---------------------------------------------------------------------------

/**
 * Return the docs with `options` filled in for every helper that takes one.
 *
 * `sources` must hold each doc's own file and everything it imports, which is
 * what {@link readOptionSources} returns. A helper with no `opts` parameter
 * comes back exactly as it went in, with no `options` key at all, so the JSON
 * for it is byte for byte what it was before this module existed.
 *
 * Throws when an `opts` parameter names a type that cannot be found or read.
 * That is a build failure on purpose: the alternative is a reference that
 * quietly lists a helper's options as nothing.
 */
export function attachHelperOptions(
  docs: readonly HelperDoc[],
  sources: readonly SourceFile[],
): HelperDoc[] {
  const modules = new Map<string, Module>();
  for (const source of sources) {
    modules.set(source.path, {
      path: source.path,
      file: ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    });
  }
  const reader = new OptionsReader(modules);
  return docs.map((doc) => {
    const options = reader.optionsOf(doc.path, doc.name);
    return options === null ? doc : { ...doc, options };
  });
}

class OptionsReader {
  constructor(private readonly modules: ReadonlyMap<string, Module>) {}

  /** The options of the helper called `name` in the file at `where`, or `null`. */
  optionsOf(where: string, name: string): HelperOptions | null {
    const module = this.modules.get(where);
    if (!module) return null;
    const entry = findHelper(module.file, name);
    if (!entry) return null;

    const index = entry.parameters.findIndex(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === OPTIONS_PARAM,
    );
    const parameter = entry.parameters[index];
    if (parameter === undefined) return null;
    if (parameter.type === undefined) {
      throw new Error(`${where}: ${name}'s ${OPTIONS_PARAM} parameter has no type, so it has no fields to list`);
    }

    const fields = this.fieldsOfType(module, parameter.type, `${name}'s ${OPTIONS_PARAM}`);
    const defaults = new Map<string, Observation[]>();
    if (ts.isFunctionDeclaration(entry) && entry.body !== undefined) {
      this.observe(module, entry, OPTIONS_PARAM, defaults, new Set());
    }

    return {
      param: OPTIONS_PARAM,
      type: collapse(parameter.type.getText(module.file)),
      fields: [...fields.values()].map((field) => {
        const value = settle(defaults.get(field.name));
        return value === undefined ? field : { ...field, default: value };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Fields
  // -------------------------------------------------------------------------

  /** The fields of a type as written in `module`: a name, or an inline literal. */
  private fieldsOfType(module: Module, type: ts.TypeNode, what: string): Map<string, OptionField> {
    if (ts.isTypeLiteralNode(type)) return this.membersOf(module, type.members, what);
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeArguments === undefined) {
      return this.fieldsOfNamed(module, type.typeName.text, what);
    }
    throw new Error(
      `${module.path}: ${what} is typed \`${type.getText(module.file)}\`. ` +
        "Only a named interface, a type alias to an object literal, or an inline object literal can be listed.",
    );
  }

  /** The fields of the interface or object type alias called `name`, inherited ones included. */
  private fieldsOfNamed(module: Module, name: string, what: string): Map<string, OptionField> {
    const found = this.lookup(module, name, isTypeDeclaration);
    if (!found) {
      throw new Error(
        `${module.path}: ${what} is typed \`${name}\`, which is not declared in the helper sources ` +
          "or reachable from them through a relative import.",
      );
    }
    const { module: home, node } = found;
    if (ts.isTypeAliasDeclaration(node)) return this.fieldsOfType(home, node.type, `type ${name}`);

    const fields = new Map<string, OptionField>();
    for (const clause of node.heritageClauses ?? []) {
      for (const base of clause.types) {
        for (const [key, field] of this.inherited(home, base, name)) {
          if (!fields.has(key)) fields.set(key, field);
        }
      }
    }
    // Own members last, so a redeclared field replaces the inherited one where
    // it stood and a new one lands after everything it extends. A redeclared
    // field with no doc of its own keeps the inherited one, as an editor would
    // show it.
    for (const [key, field] of this.membersOf(home, node.members, `interface ${name}`)) {
      const inherited = fields.get(key);
      fields.set(key, field.doc === "" && inherited !== undefined ? { ...field, doc: inherited.doc } : field);
    }
    return fields;
  }

  /** What one `extends` entry contributes: a plain name, or `Omit` and `Pick` of one. */
  private inherited(module: Module, base: ts.ExpressionWithTypeArguments, owner: string): Map<string, OptionField> {
    const written = base.getText(module.file);
    if (!ts.isIdentifier(base.expression)) {
      throw new Error(`${module.path}: interface ${owner} extends \`${written}\`, which cannot be read.`);
    }
    const name = base.expression.text;
    const args = base.typeArguments ?? [];
    if (args.length === 0) return this.fieldsOfNamed(module, name, `interface ${owner}`);

    const [target, keys] = args;
    if ((name === "Omit" || name === "Pick") && target !== undefined && keys !== undefined && args.length === 2) {
      const all = this.fieldsOfType(module, target, `interface ${owner}`);
      const listed = new Set(stringLiteralsOf(keys, module, owner));
      return new Map([...all].filter(([key]) => listed.has(key) === (name === "Pick")));
    }
    throw new Error(
      `${module.path}: interface ${owner} extends \`${written}\`. ` +
        "Only a plain interface name, Omit<...> and Pick<...> are understood.",
    );
  }

  private membersOf(module: Module, members: ts.NodeArray<ts.TypeElement>, what: string): Map<string, OptionField> {
    const fields = new Map<string, OptionField>();
    for (const member of members) {
      if (!ts.isPropertySignature(member) || member.type === undefined) {
        throw new Error(
          `${module.path}: ${what} has a member \`${collapse(member.getText(module.file))}\` that is not a typed ` +
            "property, and an options object is read field by field.",
        );
      }
      const name = propertyNameOf(member.name);
      if (name === null) {
        throw new Error(`${module.path}: ${what} has a member whose name is computed.`);
      }
      fields.set(name, {
        name,
        type: collapse(member.type.getText(module.file)),
        optional: member.questionToken !== undefined,
        doc: docOf(member, module.file),
      });
    }
    return fields;
  }

  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------

  /**
   * Record every fallback applied to `param`'s fields in `fn`, and in every
   * function `fn` hands `param` to.
   *
   * A local built by spreading `param` (`const apply = { ...opts, x }`) is read
   * as another name for it, which is how `helpers.mermaid` passes its options
   * on to `applyPlan`. Nested function declarations are skipped on the way
   * down and reached only if something calls them with the options, the same
   * as a function in another file.
   */
  private observe(
    module: Module,
    fn: ts.FunctionDeclaration,
    param: string,
    into: Map<string, Observation[]>,
    visited: Set<string>,
  ): void {
    const visitKey = `${module.path}:${String(fn.pos)}:${param}`;
    if (visited.has(visitKey) || fn.body === undefined) return;
    visited.add(visitKey);

    const names = new Set([param]);
    const record = (field: string, observation: Observation): void => {
      const list = into.get(field) ?? [];
      list.push(observation);
      into.set(field, list);
    };
    const fieldOf = (node: ts.Expression): string | null => optionFieldOf(node, names);

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node)) return;

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = unwrap(node.initializer);
        if (
          ts.isObjectLiteralExpression(initializer) &&
          initializer.properties.some(
            (property) =>
              ts.isSpreadAssignment(property) &&
              ts.isIdentifier(unwrap(property.expression)) &&
              names.has((unwrap(property.expression) as ts.Identifier).text),
          )
        ) {
          names.add(node.name.text);
        }
      }

      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.QuestionQuestionToken) {
          // `a ?? b ?? c` is `(a ?? b) ?? c`, so in `opts.labelColor ??
          // opts.color ?? 'black'` the fallback read for `labelColor` is
          // `opts.color`, which is not a constant, which is the truth.
          const field = fieldOf(node.left);
          if (field !== null) record(field, this.evaluate(module, node.right));
        }
      }

      if (ts.isCallExpression(node)) this.followCall(module, node, names, into, visited);

      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
  }

  /** Follow a call that passes the options on, into the callee's own parameter. */
  private followCall(
    module: Module,
    call: ts.CallExpression,
    names: ReadonlySet<string>,
    into: Map<string, Observation[]>,
    visited: Set<string>,
  ): void {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee)) return;
    call.arguments.forEach((argument, index) => {
      const passed = unwrap(argument);
      if (!ts.isIdentifier(passed) || !names.has(passed.text)) return;
      const target = this.lookupFunction(module, callee.text, call);
      if (!target) return;
      const parameter = target.node.parameters[index];
      if (parameter === undefined || parameter.dotDotDotToken !== undefined || !ts.isIdentifier(parameter.name)) {
        return;
      }
      this.observe(target.module, target.node, parameter.name.text, into, visited);
    });
  }

  /**
   * The value `expression` always has, or a note that it has none.
   *
   * Literals, `as const`, arrays and objects of those, and the name of a
   * `const` that holds one, followed across imports. Anything else, including
   * a local variable, is not a constant as far as a reader of the reference is
   * concerned, because its value depends on the call.
   */
  private evaluate(module: Module, expression: ts.Expression, depth = 0): Observation {
    const dynamic: Observation = { constant: false };
    if (depth > MAX_EVALUATE_DEPTH) return dynamic;
    const node = unwrap(expression);

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { constant: true, value: node.text };
    }
    if (ts.isNumericLiteral(node)) return { constant: true, value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { constant: true, value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { constant: true, value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { constant: true, value: null };

    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
    ) {
      const inner = this.evaluate(module, node.operand, depth + 1);
      if (!inner.constant || typeof inner.value !== "number") return dynamic;
      return { constant: true, value: node.operator === ts.SyntaxKind.MinusToken ? -inner.value : inner.value };
    }

    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return dynamic;
      const found = this.lookup(module, node.text, isTopLevelConst);
      if (!found || found.node.initializer === undefined) return dynamic;
      return this.evaluate(found.module, found.node.initializer, depth + 1);
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteral(unwrap(node.argumentExpression)) || ts.isNumericLiteral(unwrap(node.argumentExpression))
          ? (unwrap(node.argumentExpression) as ts.StringLiteral | ts.NumericLiteral).text
          : null;
      if (key === null) return dynamic;
      const owner = this.evaluate(module, node.expression, depth + 1);
      if (!owner.constant || owner.value === null || typeof owner.value !== "object") return dynamic;
      const value = (owner.value as Record<string, OptionDefault>)[key];
      return value === undefined || !Object.hasOwn(owner.value, key) ? dynamic : { constant: true, value };
    }

    if (ts.isArrayLiteralExpression(node)) {
      const values: OptionDefault[] = [];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = this.evaluate(module, element.expression, depth + 1);
          if (!spread.constant || !Array.isArray(spread.value)) return dynamic;
          values.push(...spread.value);
          continue;
        }
        const value = this.evaluate(module, element, depth + 1);
        if (!value.constant) return dynamic;
        values.push(value.value);
      }
      return { constant: true, value: values };
    }

    if (ts.isObjectLiteralExpression(node)) {
      const value: Record<string, OptionDefault> = {};
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = propertyNameOf(property.name);
          const inner = this.evaluate(module, property.initializer, depth + 1);
          if (key === null || !inner.constant) return dynamic;
          value[key] = inner.value;
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const inner = this.evaluate(module, property.name, depth + 1);
          if (!inner.constant) return dynamic;
          value[property.name.text] = inner.value;
        } else if (ts.isSpreadAssignment(property)) {
          const inner = this.evaluate(module, property.expression, depth + 1);
          if (!inner.constant || inner.value === null || typeof inner.value !== "object" || Array.isArray(inner.value)) {
            return dynamic;
          }
          Object.assign(value, inner.value);
        } else {
          return dynamic;
        }
      }
      return { constant: true, value };
    }

    return dynamic;
  }

  // -------------------------------------------------------------------------
  // Name lookup
  // -------------------------------------------------------------------------

  /**
   * The function a call inside `at` reaches by `name`: a declaration in an
   * enclosing block first (a sibling inside `createHelpers`), then the module's
   * top level and its imports.
   */
  private lookupFunction(module: Module, name: string, at: ts.Node): Found<ts.FunctionDeclaration> | null {
    for (let scope: ts.Node | undefined = at.parent; scope !== undefined; scope = scope.parent) {
      if (!ts.isBlock(scope)) continue;
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body !== undefined) {
          return { module, node: statement };
        }
      }
    }
    const found = this.lookup(module, name, isFunctionWithBody);
    return found;
  }

  /**
   * A top-level declaration called `name` in `module`, or the one it imports or
   * re-exports under that name, followed to the file that declares it.
   */
  private lookup<T extends ts.Node>(
    module: Module,
    name: string,
    accept: (node: ts.Node, name: string) => node is T,
    seen: Set<string> = new Set(),
  ): Found<T> | null {
    const seenKey = `${module.path}#${name}`;
    if (seen.has(seenKey)) return null;
    seen.add(seenKey);

    for (const statement of module.file.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (accept(declaration, name)) return { module, node: declaration };
        }
      } else if (accept(statement, name)) {
        return { module, node: statement };
      }
    }

    for (const statement of module.file.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      // `export { RAW as NAME }` with no `from` renames something in this file.
      const local = ts.isExportDeclaration(statement) && specifier === undefined;
      if (!local && (specifier === undefined || !ts.isStringLiteral(specifier) || !specifier.text.startsWith("."))) {
        continue;
      }
      const target = local
        ? module
        : this.modules.get(resolveSpecifier(module.path, (specifier as ts.StringLiteral).text));
      if (!target) continue;

      for (const element of namedElementsOf(statement)) {
        if (element.name.text !== name) continue;
        const original = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : name;
        if (local && original === name) continue;
        return this.lookup(target, original, accept, seen);
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small pure pieces
// ---------------------------------------------------------------------------

/**
 * The helper's own declaration in the entry file: the function that runs if
 * there is one, the interface member otherwise. The function wins for the same
 * reason it wins in `selectHelperDocs`, and it is the only one with a body to
 * read defaults from.
 */
function findHelper(file: ts.SourceFile, name: string): ts.FunctionDeclaration | ts.MethodSignature | null {
  let fn: ts.FunctionDeclaration | null = null;
  let method: ts.MethodSignature | null = null;
  const visit = (node: ts.Node): void => {
    if (fn !== null) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
      fn = node;
      return;
    }
    if (method === null && ts.isMethodSignature(node) && propertyNameOf(node.name) === name) method = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return fn ?? method;
}

/** The `{ a, b as c }` of an import or a re-export, or nothing. */
function namedElementsOf(statement: ts.Statement): readonly (ts.ImportSpecifier | ts.ExportSpecifier)[] {
  if (ts.isImportDeclaration(statement)) {
    const bindings = statement.importClause?.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : [];
  }
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    return clause !== undefined && ts.isNamedExports(clause) ? clause.elements : [];
  }
  return [];
}

function isTypeDeclaration(node: ts.Node, name: string): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  return (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === name;
}

function isFunctionWithBody(node: ts.Node, name: string): node is ts.FunctionDeclaration {
  return ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined;
}

/** A `const` at the top of a module. A `let` can change, so it is never a default. */
function isTopLevelConst(node: ts.Node, name: string): node is ts.VariableDeclaration {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === name &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/** Parentheses, `as`, `satisfies`, `<T>x` and `x!` change nothing about a value. */
function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      node = node.expression;
    } else {
      return node;
    }
  }
}

/** `opts.field` (or `opts?.field`) for one of the names the options go by, else `null`. */
function optionFieldOf(expression: ts.Expression, names: ReadonlySet<string>): string | null {
  const node = unwrap(expression);
  if (!ts.isPropertyAccessExpression(node)) return null;
  const owner = unwrap(node.expression);
  return ts.isIdentifier(owner) && names.has(owner.text) ? node.name.text : null;
}

/** The observations for one field, as its default, or `undefined` for none. */
function settle(observations: readonly Observation[] | undefined): OptionDefault | undefined {
  if (observations === undefined || observations.length === 0) return undefined;
  const [first, ...rest] = observations;
  if (first === undefined || !first.constant) return undefined;
  const text = JSON.stringify(first.value);
  for (const other of rest) {
    if (!other.constant || JSON.stringify(other.value) !== text) return undefined;
  }
  return first.value;
}

function propertyNameOf(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** `"a" | "b"` as `["a", "b"]`, for `Omit` and `Pick`. */
function stringLiteralsOf(type: ts.TypeNode, module: Module, owner: string): string[] {
  if (ts.isUnionTypeNode(type)) return type.types.flatMap((each) => stringLiteralsOf(each, module, owner));
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return [type.literal.text];
  throw new Error(
    `${module.path}: interface ${owner} omits or picks \`${type.getText(module.file)}\`, ` +
      "which is not a union of string literals.",
  );
}

/**
 * A member's own `/** ... *\/` block as one line: the comment furniture
 * stripped, every paragraph kept, tags dropped, and `{@link x}` written as
 * `` `x` ``. The whole block rather than its first paragraph, because a field's
 * second sentence is usually the one that says when to use it.
 */
function docOf(node: ts.Node, file: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(file.text, node.getFullStart()) ?? [];
  const block = [...ranges].reverse().find((range) => file.text.startsWith("/**", range.pos));
  if (block === undefined) return "";
  const body = file.text.slice(block.pos + 3, block.end - 2);
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^[ \t]*\*[ ]?/u, "").trim();
    if (line.startsWith("@")) break;
    if (line !== "") lines.push(line);
  }
  return lines
    .join(" ")
    .replace(/\{@link(?:code|plain)?\s+([^\s}|]+)(?:[\s|]+([^}]*))?\}/gu, (_match, target: string, label?: string) =>
      label !== undefined && label.trim() !== "" ? label.trim() : `\`${target}\``,
    )
    .replace(/\s+/gu, " ")
    .trim();
}

/** Newlines and runs of spaces become one space, so a type prints on one line. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").replace(/;\s*\}/gu, " }").trim();
}
