import SwaggerParser from '@apidevtools/swagger-parser';
import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const spec = await SwaggerParser.validate(join(root, 'docs/openapi.json'));
const documented = new Set();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    if (item[method]) documented.add(`${method.toUpperCase()} ${path}`);
  }
}
const implemented = new Set();
for (const filename of await readdir(join(root, 'server/src'))) {
  if (!filename.endsWith('.ts')) continue;
  const source = ts.createSourceFile(filename, await readFile(join(root, 'server/src', filename), 'utf8'), ts.ScriptTarget.Latest, true);
  const strings = new Map();
  function literal(node) {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return strings.get(node.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left), right = literal(node.right);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = literal(span.expression);
        if (part === undefined) return undefined;
        value += part + span.literal.text;
      }
      return value;
    }
  }
  function walk(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const value = literal(node.initializer);
      if (value !== undefined) strings.set(node.name.text, value);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (['get', 'post', 'patch', 'put', 'delete'].includes(method)) {
        const route = literal(node.arguments[0]);
        if (route?.startsWith('/api/v1/')) implemented.add(`${method.toUpperCase()} ${route.slice('/api/v1'.length).replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
}
if (implemented.size < 20) throw new Error('Could not discover the complete API route list; update check-openapi.mjs for the new route registration style.');
const missing = [...implemented].filter((operation) => !documented.has(operation));
const extra = [...documented].filter((operation) => !implemented.has(operation));
if (missing.length || extra.length) throw new Error(`OpenAPI / implementation mismatch. Missing: ${missing.join(', ') || 'none'}. Unimplemented: ${extra.join(', ') || 'none'}.`);
console.log(`OpenAPI valid; ${implemented.size} operations match the server routes.`);
