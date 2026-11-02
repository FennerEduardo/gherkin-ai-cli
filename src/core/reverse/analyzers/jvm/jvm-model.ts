/* ==========================================================================
   gherkin-ai-cli - Java / Kotlin source model for `ghk reverse`

   tree-sitter-java and tree-sitter-kotlin shape the same things differently
   (`modifiers > annotation > name` vs `modifiers > annotation >
   constructor_invocation > user_type`). This module reads both into one
   small model: classes with their annotations, fields (for dependency
   injection), constructor parameters and methods; methods with their
   annotations, parameters and body. The framework adapter (spring.ts) only
   sees this model.
   ========================================================================== */

import { childOfType, childrenOfType, ofType, unquote, type TSNode } from '../treesitter/loader';

export type JvmLanguage = 'java' | 'kotlin';

export interface Annotation {
  name: string;
  /** String literal arguments, in order. */
  strings: string[];
  /** Named arguments (`value = "/x"`, `method = RequestMethod.POST`), raw text. */
  pairs: Record<string, string>;
  /** All argument text. */
  raw: string;
  node: TSNode;
}

export interface JvmParam {
  name: string;
  type: string;
  annotations: Annotation[];
}

export interface JvmMethod {
  name: string;
  annotations: Annotation[];
  params: JvmParam[];
  body?: TSNode;
  node: TSNode;
}

export interface JvmClass {
  name: string;
  kind: 'class' | 'record' | 'interface' | 'enum' | 'object';
  annotations: Annotation[];
  /** Field (or constructor property) name → type name, for dependency injection. */
  fields: Map<string, string>;
  /** Record components / Kotlin primary-constructor properties with their annotations (DTO validation). */
  properties: JvmParam[];
  methods: JvmMethod[];
  /** Simple name of the superclass, when there is one. */
  superclass?: string;
  file: string;
  lang: JvmLanguage;
  node: TSNode;
}

/** `ResponseEntity<Map<String, X>>` → `ResponseEntity`; `List<Order>?` → `List`. */
const simpleType = (text: string) => text.replace(/[?\s]/g, '').replace(/<.*$/, '').split('.').pop() ?? text;

function annotationFrom(node: TSNode, lang: JvmLanguage): Annotation | undefined {
  let name: string | undefined;
  let args: TSNode | undefined;
  if (lang === 'java') {
    name = node.childForFieldName('name')?.text.split('.').pop();
    args = node.childForFieldName('arguments') ?? undefined;
  } else {
    const inv = childOfType(node, 'constructor_invocation');
    const user = inv ? childOfType(inv, 'user_type') : childOfType(node, 'user_type');
    name = user?.text.split('.').pop();
    args = inv ? childOfType(inv, 'value_arguments') : undefined;
  }
  if (!name) return undefined;
  const strings: string[] = [];
  const pairs: Record<string, string> = {};
  if (args) {
    for (const lit of ofType(args, 'string_literal')) {
      const v = unquote(lit.text);
      if (v !== undefined) strings.push(v);
    }
    if (lang === 'java') {
      for (const pair of childrenOfType(args, 'element_value_pair')) {
        const key = pair.childForFieldName('key')?.text;
        const value = pair.childForFieldName('value')?.text;
        if (key && value) pairs[key] = value;
      }
    } else {
      for (const va of childrenOfType(args, 'value_argument')) {
        const key = childOfType(va, 'simple_identifier');
        if (key && va.namedChildren.length > 1) pairs[key.text] = va.namedChildren[va.namedChildren.length - 1]!.text;
      }
    }
  }
  return { name, strings, pairs, raw: args?.text ?? '', node };
}

function annotationsIn(modifiers: TSNode | undefined, lang: JvmLanguage): Annotation[] {
  if (!modifiers) return [];
  const types = lang === 'java' ? ['marker_annotation', 'annotation'] : ['annotation'];
  return childrenOfType(modifiers, ...types).map(a => annotationFrom(a, lang)).filter((a): a is Annotation => Boolean(a));
}

function javaParams(list: TSNode | null | undefined): JvmParam[] {
  return childrenOfType(list, 'formal_parameter', 'spread_parameter').map(p => ({
    name: p.childForFieldName('name')?.text ?? '',
    type: simpleType(p.childForFieldName('type')?.text ?? ''),
    annotations: annotationsIn(childOfType(p, 'modifiers'), 'java')
  }));
}

function kotlinParams(list: TSNode | undefined): JvmParam[] {
  const out: JvmParam[] = [];
  let pending: Annotation[] = [];
  for (const child of list?.namedChildren ?? []) {
    if (!child) continue;
    if (child.type === 'parameter_modifiers') pending = annotationsIn(child, 'kotlin');
    if (child.type === 'parameter') {
      out.push({ name: childOfType(child, 'simple_identifier')?.text ?? '', type: simpleType(child.namedChildren.find(c => c && c.type !== 'simple_identifier')?.text ?? ''), annotations: pending });
      pending = [];
    }
  }
  return out;
}

function javaClass(node: TSNode, file: string): JvmClass {
  const kind = node.type === 'record_declaration' ? 'record' : node.type === 'interface_declaration' ? 'interface' : node.type === 'enum_declaration' ? 'enum' : 'class';
  const body = node.childForFieldName('body');
  const fields = new Map<string, string>();
  const methods: JvmMethod[] = [];
  for (const member of body?.namedChildren ?? []) {
    if (!member) continue;
    if (member.type === 'field_declaration') {
      const type = simpleType(member.childForFieldName('type')?.text ?? '');
      for (const d of childrenOfType(member, 'variable_declarator')) fields.set(d.childForFieldName('name')?.text ?? '', type);
    }
    if (member.type === 'constructor_declaration') {
      for (const p of javaParams(member.childForFieldName('parameters'))) if (!fields.has(p.name)) fields.set(p.name, p.type);
    }
    if (member.type === 'method_declaration') {
      methods.push({
        name: member.childForFieldName('name')?.text ?? '',
        annotations: annotationsIn(childOfType(member, 'modifiers'), 'java'),
        params: javaParams(member.childForFieldName('parameters')),
        body: member.childForFieldName('body') ?? undefined,
        node: member
      });
    }
  }
  const properties = kind === 'record' ? javaParams(node.childForFieldName('parameters')) : [];
  // Annotated fields of a DTO class are its properties too.
  if (kind === 'class') {
    for (const member of body?.namedChildren ?? []) {
      if (member?.type !== 'field_declaration') continue;
      const annotations = annotationsIn(childOfType(member, 'modifiers'), 'java');
      const type = simpleType(member.childForFieldName('type')?.text ?? '');
      for (const d of childrenOfType(member, 'variable_declarator')) properties.push({ name: d.childForFieldName('name')?.text ?? '', type, annotations });
    }
  }
  const superclass = node.childForFieldName('superclass')?.text.replace(/^extends\s+/, '');
  return { name: node.childForFieldName('name')?.text ?? '', kind, annotations: annotationsIn(childOfType(node, 'modifiers'), 'java'), fields, properties, methods, superclass: superclass ? simpleType(superclass) : undefined, file, lang: 'java', node };
}

function kotlinClass(node: TSNode, file: string): JvmClass {
  const fields = new Map<string, string>();
  const properties: JvmParam[] = [];
  const methods: JvmMethod[] = [];
  for (const cp of ofType(childOfType(node, 'primary_constructor') ?? node, 'class_parameter')) {
    const name = childOfType(cp, 'simple_identifier')?.text ?? '';
    const type = simpleType(childOfType(cp, 'user_type', 'nullable_type')?.text ?? '');
    fields.set(name, type);
    properties.push({ name, type, annotations: annotationsIn(childOfType(cp, 'modifiers'), 'kotlin') });
  }
  const body = childOfType(node, 'class_body', 'enum_class_body');
  for (const member of body?.namedChildren ?? []) {
    if (!member) continue;
    if (member.type === 'property_declaration') {
      const v = childOfType(member, 'variable_declaration');
      const name = childOfType(v, 'simple_identifier')?.text;
      const type = childOfType(v, 'user_type', 'nullable_type')?.text;
      if (name) fields.set(name, simpleType(type ?? ''));
    }
    if (member.type === 'function_declaration') {
      methods.push({
        name: childOfType(member, 'simple_identifier')?.text ?? '',
        annotations: annotationsIn(childOfType(member, 'modifiers'), 'kotlin'),
        params: kotlinParams(childOfType(member, 'function_value_parameters')),
        body: childOfType(member, 'function_body'),
        node: member
      });
    }
  }
  const isInterface = /^\s*(?:@[\w.()"'/ ,=-]+\s+)*(?:\w+\s+)*interface\b/.test(node.text.split('{')[0]);
  const delegation = childOfType(node, 'delegation_specifier');
  return {
    name: childOfType(node, 'type_identifier')?.text ?? '', kind: node.type === 'object_declaration' ? 'object' : isInterface ? 'interface' : 'class',
    annotations: annotationsIn(childOfType(node, 'modifiers'), 'kotlin'), fields, properties, methods,
    superclass: delegation ? simpleType(delegation.text.replace(/\(.*$/, '')) : undefined, file, lang: 'kotlin', node
  };
}

/** Every class, record, interface and object declared in a file (nested ones included). */
export function classesIn(root: TSNode, file: string, lang: JvmLanguage): JvmClass[] {
  if (lang === 'java') return ofType(root, 'class_declaration', 'record_declaration', 'interface_declaration').map(n => javaClass(n, file));
  return ofType(root, 'class_declaration', 'object_declaration').map(n => kotlinClass(n, file));
}

export const annotation = (list: Annotation[], ...names: string[]) => list.find(a => names.includes(a.name));
