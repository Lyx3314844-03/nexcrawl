import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import babelParser from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';

const traverse = traverseModule.default;
const BUILTIN_SET = new Set([...builtinModules, ...builtinModules.map((name) => name.replace(/^node:/, ''))]);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const CLI_FRAMEWORKS = new Set(['commander', 'yargs', 'yargs-parser', 'minimist', 'cac', 'meow', 'oclif']);
const SERVER_FRAMEWORK_MODULES = new Set([
  'express',
  'koa',
  '@koa/router',
  'koa-router',
  'fastify',
  '@hapi/hapi',
  'restify',
]);
const HTTP_CLIENT_INSTANCE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);
const GRAPHQL_INSTANCE_METHODS = new Set(['request', 'rawRequest']);
const WEBSOCKET_LISTENER_METHODS = new Set(['on', 'once', 'addEventListener']);
const WEBSOCKET_EMIT_METHODS = new Set(['emit', 'send', 'write']);
const WEBSOCKET_MIDDLEWARE_METHODS = new Set(['use']);
const WEBSOCKET_ROOM_CHAIN_METHODS = new Set(['to', 'in']);
const WEBSOCKET_ROOM_STATE_METHODS = new Set(['join', 'leave']);

const parserOptions = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  plugins: [
    'jsx',
    'typescript',
    'doExpressions',
    'objectRestSpread',
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'decorators-legacy',
    'dynamicImport',
    'optionalChaining',
    'nullishCoalescingOperator',
    'topLevelAwait',
    'bigInt',
    'numericSeparator',
  ],
};

function parse(code) {
  try {
    return {
      success: true,
      ast: babelParser.parse(code, parserOptions),
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      ast: null,
      error: error?.message ?? String(error),
    };
  }
}

function normalizeAnalysisTarget(target) {
  if (!target || typeof target !== 'string') return null;
  if (target.startsWith('inline://')) return null;
  if (target.startsWith('file://')) {
    try {
      return fileURLToPath(target);
    } catch {
      return null;
    }
  }
  if (target.includes('://')) return null;
  return isAbsolute(target) ? target : resolvePath(target);
}

function isRelativeModuleSource(source) {
  return typeof source === 'string' && (source.startsWith('./') || source.startsWith('../'));
}

function resolveLocalModuleFile(source, fromFile) {
  if (!isRelativeModuleSource(source) || !fromFile) return null;

  const basePath = resolvePath(dirname(fromFile), source);
  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}.ts`,
    resolvePath(basePath, 'index.js'),
    resolvePath(basePath, 'index.mjs'),
    resolvePath(basePath, 'index.cjs'),
    resolvePath(basePath, 'index.ts'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function literalLocation(node) {
  return {
    line: node?.loc?.start?.line ?? null,
    column: node?.loc?.start?.column ?? null,
  };
}

function memberPath(node) {
  if (!node) return null;
  if (t.isIdentifier(node)) return node.name;
  if (t.isThisExpression(node)) return 'this';
  if (t.isSuper(node)) return 'super';
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isMemberExpression(node)) {
    const objectName = memberPath(node.object);
    const propertyName = node.computed ? memberPath(node.property) : node.property?.name ?? memberPath(node.property);
    if (!objectName && !propertyName) return null;
    return objectName && propertyName ? `${objectName}.${propertyName}` : objectName ?? propertyName;
  }
  if (t.isOptionalMemberExpression(node)) {
    const objectName = memberPath(node.object);
    const propertyName = node.computed ? memberPath(node.property) : node.property?.name ?? memberPath(node.property);
    if (!objectName && !propertyName) return null;
    return objectName && propertyName ? `${objectName}.${propertyName}` : objectName ?? propertyName;
  }
  return null;
}

function classifyModuleSource(source) {
  if (!source) return 'unknown';
  const normalized = String(source).replace(/^node:/, '');
  if (BUILTIN_SET.has(source) || BUILTIN_SET.has(normalized)) return 'builtin';
  if (normalized.startsWith('./') || normalized.startsWith('../') || normalized.startsWith('/')) return 'relative';
  return 'external';
}

function buildImportBindings(ast) {
  const bindings = new Map();
  const dependencies = [];

  function register(source, localName, importedName = null) {
    if (!localName) return;
    const normalizedSource = String(source);
    const moduleType = classifyModuleSource(normalizedSource);
    const canonicalSource = normalizedSource.replace(/^node:/, '');
    const bindingValue = importedName ? `${canonicalSource}.${importedName}` : canonicalSource;
    bindings.set(localName, bindingValue);
    dependencies.push({
      source: normalizedSource,
      moduleType,
      binding: localName,
      imported: importedName,
    });
  }

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      for (const specifier of path.node.specifiers) {
        if (t.isImportDefaultSpecifier(specifier) || t.isImportNamespaceSpecifier(specifier)) {
          register(source, specifier.local.name, null);
          continue;
        }

        if (t.isImportSpecifier(specifier)) {
          register(
            source,
            specifier.local.name,
            t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value,
          );
        }
      }
    },
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!t.isCallExpression(init) || !t.isIdentifier(init.callee, { name: 'require' })) return;
      const firstArg = init.arguments[0];
      if (!t.isStringLiteral(firstArg)) return;
      const source = firstArg.value;

      if (t.isIdentifier(path.node.id)) {
        register(source, path.node.id.name, null);
        return;
      }

      if (t.isObjectPattern(path.node.id)) {
        for (const property of path.node.id.properties) {
          if (t.isObjectProperty(property) && t.isIdentifier(property.value)) {
            const importedName = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
            register(source, property.value.name, importedName);
          }
        }
      }
    },
  });

  return {
    bindings,
    dependencies,
  };
}

function expandBindingName(name, bindings) {
  if (!name) return null;
  const [head, ...rest] = name.split('.');
  const binding = bindings.get(head);
  if (!binding) return name;
  return [binding, ...rest].join('.');
}

function stableValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stableValue(entry)]));
  }
  return undefined;
}

function getResolvedScalar(node, constants) {
  const resolved = resolveNodeValue(node, constants, 0);
  if (!resolved.resolved) return null;
  if (typeof resolved.value === 'string' || typeof resolved.value === 'number' || typeof resolved.value === 'boolean') {
    return resolved.value;
  }
  return null;
}

function getResolvedString(node, constants) {
  const value = getResolvedScalar(node, constants);
  return value === null ? null : String(value);
}

function getResolvedStringInContext(node, constants, functionDefinitions, context, depth = 0) {
  if (!node || depth > 4) return null;
  const contextual = resolveContextExpression(node, context);
  if (contextual) {
    return getResolvedStringInContext(contextual, constants, functionDefinitions, context, depth + 1);
  }

  if (t.isCallExpression(node) && t.isIdentifier(node.callee) && functionDefinitions.has(node.callee.name)) {
    const functionNode = functionDefinitions.get(node.callee.name);
    const returnExpression = getFunctionReturnExpression(functionNode);
    if (returnExpression) {
      const params = new Map();
      for (let index = 0; index < (functionNode.params?.length ?? 0); index += 1) {
        const param = functionNode.params[index];
        if (!t.isIdentifier(param)) continue;
        params.set(param.name, resolveContextExpression(node.arguments[index], context) ?? node.arguments[index] ?? null);
      }
      return getResolvedStringInContext(returnExpression, constants, functionDefinitions, {
        params,
        thisBindings: context?.thisBindings ?? new Map(),
      }, depth + 1);
    }
  }

  return getResolvedStringWithHelpers(node, constants, functionDefinitions, depth);
}

function getObjectStringInContext(node, keys, constants, functionDefinitions, context) {
  const valueNode = findObjectProperty(node, keys);
  return valueNode ? getResolvedStringInContext(valueNode, constants, functionDefinitions, context) : null;
}

function getFunctionReturnExpression(node) {
  if (!node) return null;
  if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
    return node.body;
  }
  const statements = getFunctionBodyStatements(node);
  if (statements.length === 0) return null;
  const returnStatement = statements.find((entry) => t.isReturnStatement(entry));
  return t.isReturnStatement(returnStatement) ? returnStatement.argument ?? null : null;
}

function getResolvedScalarWithHelpers(node, constants, functionDefinitions, depth = 0) {
  if (!node || depth > 4) return null;
  const direct = getResolvedScalar(node, constants);
  if (direct !== null) return direct;

  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
    const fnNode = functionDefinitions.get(node.callee.name);
    const returnExpression = getFunctionReturnExpression(fnNode);
    if (!returnExpression) return null;

    const mergedConstants = new Map(constants);
    for (let index = 0; index < (fnNode?.params?.length ?? 0); index += 1) {
      const param = fnNode.params[index];
      if (!t.isIdentifier(param)) continue;
      const argumentValue = getResolvedScalarWithHelpers(node.arguments[index], constants, functionDefinitions, depth + 1);
      if (argumentValue !== null) {
        mergedConstants.set(param.name, argumentValue);
      }
    }
    return getResolvedScalarWithHelpers(returnExpression, mergedConstants, functionDefinitions, depth + 1);
  }

  return null;
}

function getResolvedStringWithHelpers(node, constants, functionDefinitions, depth = 0) {
  const value = getResolvedScalarWithHelpers(node, constants, functionDefinitions, depth);
  return value === null ? null : String(value);
}

function getRootIdentifierName(node) {
  if (!node) return null;
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) return getRootIdentifierName(node.object);
  return null;
}

function inferCallableName(node) {
  if (!node) return null;
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) return memberPath(node);
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return '[inline]';
  return null;
}

function findObjectProperty(node, names) {
  if (!t.isObjectExpression(node)) return null;
  const keys = Array.isArray(names) ? names : [names];
  for (const property of node.properties) {
    if (!t.isObjectProperty(property)) continue;
    const key = t.isIdentifier(property.key)
      ? property.key.name
      : t.isStringLiteral(property.key)
        ? property.key.value
        : null;
    if (key && keys.includes(key)) {
      return property.value;
    }
  }
  return null;
}

function getObjectString(node, keys, constants) {
  const valueNode = findObjectProperty(node, keys);
  return valueNode ? getResolvedString(valueNode, constants) : null;
}

function getObjectArray(node, keys, constants) {
  const valueNode = findObjectProperty(node, keys);
  if (!valueNode) return [];
  if (t.isArrayExpression(valueNode)) {
    return valueNode.elements
      .map((entry) => getResolvedString(entry, constants))
      .filter(Boolean)
      .map((entry) => String(entry).toUpperCase());
  }
  const single = getResolvedString(valueNode, constants);
  return single ? [single.toUpperCase()] : [];
}

function classifyHttpClientCall(callee) {
  if (!callee) return null;
  if (callee === 'fetch' || callee === 'global.fetch' || callee === 'node-fetch' || callee === 'cross-fetch') {
    return { client: callee.replace(/^global\./, ''), transport: 'fetch' };
  }
  if (/^(?:undici)\.(?:fetch|request|stream|pipeline|dispatch)$/.test(callee)) {
    return { client: 'undici', transport: callee.split('.').at(-1) ?? 'request' };
  }
  if (/^(?:http|https|node:http|node:https)\.(?:request|get)$/.test(callee)) {
    return { client: callee.split('.')[0].replace(/^node:/, ''), transport: callee.split('.').at(-1) ?? 'request' };
  }
  if (/^(?:axios|superagent|ky|got)(?:$|\.)/.test(callee)) {
    return { client: callee.split('.')[0], transport: 'http-client-library' };
  }
  if (/^(?:graphql-request)\.(?:request|rawRequest)$/.test(callee)) {
    return { client: 'graphql-request', transport: 'graphql' };
  }
  return null;
}

function extractRequestTarget(argumentsList, constants) {
  for (const argumentNode of argumentsList ?? []) {
    const direct = getResolvedString(argumentNode, constants);
    if (direct) return direct;
    if (t.isObjectExpression(argumentNode)) {
      const url = getObjectString(argumentNode, ['url', 'href', 'uri'], constants);
      if (url) return url;
      const protocol = getObjectString(argumentNode, ['protocol'], constants);
      const host = getObjectString(argumentNode, ['hostname', 'host'], constants);
      const path = getObjectString(argumentNode, ['path', 'pathname'], constants);
      if (host || path) {
        const prefix = protocol ? `${protocol.replace(/:$/, '')}://` : '';
        return `${prefix}${host ?? ''}${path ?? ''}`;
      }
    }
  }
  return null;
}

function classifyGraphQLCall(callee) {
  if (!callee) return null;
  if (callee === 'graphql' || callee.endsWith('.graphql')) return 'graphql-execute';
  if (callee === 'express-graphql.graphqlHTTP' || callee.endsWith('.graphqlHTTP')) return 'graphql-http';
  if (callee === 'graphqlHTTPKoa' || callee.endsWith('.graphqlHTTPKoa')) return 'graphql-http-koa';
  if (callee === 'koaMiddleware' || callee.endsWith('.koaMiddleware')) return 'graphql-koa-middleware';
  if (callee === 'expressMiddleware' || callee.endsWith('.expressMiddleware')) return 'apollo-express-middleware';
  if (callee === 'getMiddleware' || callee.endsWith('.getMiddleware')) return 'apollo-get-middleware';
  if (callee === 'startServerAndCreateLambdaHandler' || callee.endsWith('.startServerAndCreateLambdaHandler')) return 'apollo-lambda-handler';
  if (callee === 'startServerAndCreateNextHandler' || callee.endsWith('.startServerAndCreateNextHandler')) return 'apollo-next-handler';
  if (callee === 'startServerAndCreateCloudflareWorkersHandler' || callee.endsWith('.startServerAndCreateCloudflareWorkersHandler')) return 'apollo-cloudflare-handler';
  if (callee === 'graphql-request.GraphQLClient' || callee.endsWith('.GraphQLClient')) return 'graphql-client';
  if (callee === 'graphql-yoga.createYoga' || callee.endsWith('.createYoga')) return 'graphql-yoga';
  if (callee === 'createHandler' || callee.endsWith('.createHandler')) return 'graphql-handler';
  if (callee === 'mercurius' || callee.endsWith('.mercurius')) return 'graphql-mercurius';
  if (callee.endsWith('.ApolloServer') || callee === 'ApolloServer') return 'apollo-server';
  return null;
}

function extractGraphqlTarget(args, kind, constants, functionDefinitions, context = null) {
  if (kind === 'apollo-express-middleware') {
    return getObjectStringInContext(args?.[1], ['path'], constants, functionDefinitions, context) ?? null;
  }
  if (kind === 'apollo-get-middleware') {
    return getObjectStringInContext(args?.[0], ['path'], constants, functionDefinitions, context) ?? '/graphql';
  }
  if (kind === 'graphql-yoga') {
    return getObjectStringInContext(args?.[0], ['graphqlEndpoint', 'path', 'endpoint'], constants, functionDefinitions, context) ?? '/graphql';
  }
  if (kind === 'graphql-handler') {
    return getObjectStringInContext(args?.[0], ['path', 'graphqlEndpoint', 'endpoint'], constants, functionDefinitions, context) ?? '/graphql';
  }
  if (kind === 'apollo-lambda-handler' || kind === 'apollo-next-handler' || kind === 'apollo-cloudflare-handler') {
    return getObjectStringInContext(args?.[1], ['path', 'graphqlEndpoint', 'endpoint'], constants, functionDefinitions, context) ?? '/graphql';
  }
  if (kind === 'graphql-http' || kind === 'graphql-http-koa' || kind === 'graphql-koa-middleware') {
    return getObjectStringInContext(args?.[0], ['path', 'graphqlEndpoint', 'endpoint'], constants, functionDefinitions, context) ?? null;
  }
  if (kind === 'graphql-execute') {
    return getResolvedStringInContext(args?.[0], constants, functionDefinitions, context);
  }
  return extractRequestTarget(args, constants);
}

function classifyHttpClientFactory(callee) {
  if (!callee) return null;
  if (/^(?:axios|got|ky)\.(?:create|extend)$/.test(callee)) {
    return callee.split('.')[0];
  }
  if (callee === 'superagent.agent') {
    return 'superagent';
  }
  return null;
}

function normalizeFrameworkName(framework) {
  if (!framework) return framework;
  if (framework === '@koa/router' || framework === 'koa-router') return 'koa-router';
  if (framework === '@hapi/hapi') return 'hapi';
  return framework;
}

function resolveAbsoluteTarget(baseTarget, nextTarget) {
  if (nextTarget == null) return baseTarget ?? null;
  if (baseTarget == null) return nextTarget;
  try {
    return new URL(String(nextTarget), String(baseTarget)).toString();
  } catch {
    return String(nextTarget);
  }
}

function extractBaseTarget(node, constants) {
  if (!node) return null;
  if (t.isObjectExpression(node)) {
    return getObjectString(node, ['baseURL', 'baseUrl', 'prefixUrl', 'url', 'href', 'uri'], constants);
  }
  return getResolvedString(node, constants);
}

function pushRouteRecord(routes, record) {
  pushUnique(
    routes,
    record,
    (item) => `${item.framework}:${item.container}:${item.method}:${item.path}:${item.location.line}:${item.location.column}`,
  );
}

function pushGraphqlRecord(graphql, record) {
  pushUnique(
    graphql,
    record,
    (item) => `${item.kind}:${item.api}:${item.target}:${item.location.line}:${item.location.column}`,
  );
}

function joinRoutePath(prefix, routePath) {
  const left = typeof prefix === 'string' ? prefix.trim() : '';
  const right = typeof routePath === 'string' ? routePath.trim() : '';
  if (!left && !right) return null;
  if (!left) return right || null;
  if (!right) return left || null;
  const normalizedLeft = left.endsWith('/') ? left.slice(0, -1) : left;
  const normalizedRight = right.startsWith('/') ? right : `/${right}`;
  return `${normalizedLeft}${normalizedRight}` || null;
}

function resolveRouteBuilder(callNode, routeContainers, routeBuilderContainers, constants) {
  if (!t.isCallExpression(callNode)) return null;
  const callee = callNode.callee;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return null;
  const propertyName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
  if (propertyName && HTTP_METHODS.has(String(propertyName).toLowerCase()) && t.isCallExpression(callee.object)) {
    return resolveRouteBuilder(callee.object, routeContainers, routeBuilderContainers, constants);
  }
  if (propertyName !== 'route') return null;

  const targetName = getRootIdentifierName(callee.object);
  if (!targetName) return null;
  const framework = routeContainers.get(targetName) ?? routeBuilderContainers.get(targetName)?.framework ?? null;
  if (!framework) return null;

  return {
    container: targetName,
    framework,
    path: getResolvedString(callNode.arguments[0], constants),
  };
}

function collectMountedRouteRecords(rawRoutes, routeMounts, routePrefixes = new Map()) {
  const expanded = [];
  const visit = (record, containerName, seen = new Set()) => {
    const prefix = routePrefixes.get(containerName) ?? null;
    const normalizedRecord = prefix
      ? {
          ...record,
          path: joinRoutePath(prefix, record.path),
        }
      : record;
    const mounts = routeMounts.get(containerName) ?? [];
    if (mounts.length === 0) {
      expanded.push(normalizedRecord);
      return;
    }

    let mounted = false;
    for (const mount of mounts) {
      const cycleKey = `${containerName}:${mount.parent}:${mount.prefix}`;
      if (seen.has(cycleKey)) continue;
      mounted = true;
      const nextSeen = new Set(seen);
      nextSeen.add(cycleKey);
      visit({
        ...normalizedRecord,
        container: mount.parent,
        framework: mount.parentFramework ?? normalizedRecord.framework,
        path: joinRoutePath(mount.prefix, normalizedRecord.path),
      }, mount.parent, nextSeen);
    }

    if (!mounted) {
      expanded.push(normalizedRecord);
    }
  };

  for (const record of rawRoutes) {
    visit(record, record.container);
  }

  const deduped = [];
  for (const record of expanded) {
    pushRouteRecord(deduped, record);
  }
  return deduped;
}

function extractSingleRouteEntryFromNode(node, constants, functionDefinitions) {
  if (!node) return [];

  if (t.isObjectExpression(node)) {
    const methodNode = findObjectProperty(node, ['method', 'verb']);
    const pathNode = findObjectProperty(node, ['path', 'url', 'pathname', 'routePath']);
    const patternNode = findObjectProperty(node, ['pattern', 'regex', 'matcher']);
    const method = methodNode ? getResolvedStringWithHelpers(methodNode, constants, functionDefinitions) : null;
    const path = pathNode
      ? getResolvedStringWithHelpers(pathNode, constants, functionDefinitions)
      : t.isRegExpLiteral(patternNode)
        ? `regex:${patternNode.extra?.raw ?? `/${patternNode.pattern}/${patternNode.flags}`}`
        : null;
    return method || path
      ? [{
          method: method ? method.toUpperCase() : null,
          path,
        }]
      : [];
  }

  if (t.isArrayExpression(node)) {
    const method = getResolvedStringWithHelpers(node.elements[0], constants, functionDefinitions);
    const routeValue = node.elements[1];
    const path = t.isRegExpLiteral(routeValue)
      ? `regex:${routeValue.extra?.raw ?? `/${routeValue.pattern}/${routeValue.flags}`}`
      : getResolvedStringWithHelpers(routeValue, constants, functionDefinitions);
    return method || path
      ? [{
          method: method ? method.toUpperCase() : null,
          path,
        }]
      : [];
  }

  return [];
}

function extractRouteTableEntriesFromNode(node, constants, functionDefinitions) {
  if (t.isCallExpression(node) && t.isIdentifier(node.callee) && functionDefinitions.has(node.callee.name)) {
    const functionNode = functionDefinitions.get(node.callee.name);
    const returnExpression = getFunctionReturnExpression(functionNode);
    if (!returnExpression) return [];
    const mergedConstants = new Map(constants);
    const paramBindings = buildParameterBindings(functionNode.params, node.arguments);
    for (const [name, expression] of paramBindings.entries()) {
      const resolved = getResolvedScalarWithHelpers(expression, constants, functionDefinitions);
      if (resolved !== null) {
        mergedConstants.set(name, resolved);
      }
    }
    return extractRouteTableEntriesFromNode(returnExpression, mergedConstants, functionDefinitions);
  }

  const singleEntry = extractSingleRouteEntryFromNode(node, constants, functionDefinitions);
  if (singleEntry.length > 0) return singleEntry;

  if (!t.isArrayExpression(node)) return [];
  const entries = [];
  for (const element of node.elements) {
    if (!element) continue;
    entries.push(...extractSingleRouteEntryFromNode(element, constants, functionDefinitions));
  }
  return entries;
}

function collectRouteTableMutationEntries(node, constants, functionDefinitions, tables) {
  if (t.isIdentifier(node) && tables.has(node.name)) {
    return [...(tables.get(node.name) ?? [])];
  }
  return extractRouteTableEntriesFromNode(node, constants, functionDefinitions);
}

function collectRouteTables(ast, constants, functionDefinitions, seedTables = new Map()) {
  const tables = cloneRouteTables(seedTables);
  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !path.node.init) return;
      const entries = extractRouteTableEntriesFromNode(path.node.init, constants, functionDefinitions);
      if (entries.length > 0) {
        tables.set(path.node.id.name, entries);
      }
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return;
      if (!t.isIdentifier(callee.object)) return;
      const tableName = callee.object.name;
      const methodName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
      if (!methodName) return;

      const ensureTable = () => {
        if (!tables.has(tableName)) tables.set(tableName, []);
        return tables.get(tableName);
      };

      if (methodName === 'push' || methodName === 'unshift') {
        const target = ensureTable();
        for (const argumentNode of path.node.arguments) {
          target.push(...collectRouteTableMutationEntries(argumentNode, constants, functionDefinitions, tables));
        }
        return;
      }

      if (methodName === 'splice' && path.node.arguments.length > 2) {
        const target = ensureTable();
        for (const argumentNode of path.node.arguments.slice(2)) {
          target.push(...collectRouteTableMutationEntries(argumentNode, constants, functionDefinitions, tables));
        }
      }
    },
    AssignmentExpression(path) {
      if (!t.isIdentifier(path.node.left)) return;
      const tableName = path.node.left.name;
      const nextEntries = extractRouteTableEntriesFromNode(path.node.right, constants, functionDefinitions);
      if (nextEntries.length > 0) {
        tables.set(tableName, nextEntries);
        return;
      }

      if (t.isCallExpression(path.node.right)) {
        const callee = path.node.right.callee;
        if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && t.isIdentifier(callee.object, { name: tableName })) {
          const methodName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
          if (methodName === 'concat') {
            const merged = [...(tables.get(tableName) ?? [])];
            for (const argumentNode of path.node.right.arguments) {
              merged.push(...collectRouteTableMutationEntries(argumentNode, constants, functionDefinitions, tables));
            }
            tables.set(tableName, merged);
          }
        }
      }
    },
  });

  const orderedStatements = t.isProgram(ast.program) ? ast.program.body : [];
  for (const statement of orderedStatements) {
    if (!t.isExpressionStatement(statement)) continue;

    if (t.isCallExpression(statement.expression)) {
      const callee = statement.expression.callee;
      if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && t.isIdentifier(callee.object)) {
        const tableName = callee.object.name;
        const methodName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
        if (!methodName) continue;
        if (!tables.has(tableName)) tables.set(tableName, []);
        const target = tables.get(tableName);

        if (methodName === 'push' || methodName === 'unshift') {
          for (const argumentNode of statement.expression.arguments) {
            target.push(...collectRouteTableMutationEntries(argumentNode, constants, functionDefinitions, tables));
          }
          continue;
        }

        if (methodName === 'splice' && statement.expression.arguments.length > 2) {
          for (const argumentNode of statement.expression.arguments.slice(2)) {
            target.push(...collectRouteTableMutationEntries(argumentNode, constants, functionDefinitions, tables));
          }
        }
      }
    }

    if (t.isAssignmentExpression(statement.expression) && t.isIdentifier(statement.expression.left)) {
      const tableName = statement.expression.left.name;
      const nextEntries = extractRouteTableEntriesFromNode(statement.expression.right, constants, functionDefinitions);
      if (nextEntries.length > 0) {
        tables.set(tableName, nextEntries);
        continue;
      }

        if (t.isCallExpression(statement.expression.right)) {
          const callee = statement.expression.right.callee;
          if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && t.isIdentifier(callee.object, { name: tableName })) {
            const methodName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
            if (methodName === 'concat') {
              const merged = [...(tables.get(tableName) ?? [])];
              for (const argumentNode of statement.expression.right.arguments) {
                merged.push(...collectRouteTableMutationEntries(argumentNode, constants, functionDefinitions, tables));
              }
              tables.set(tableName, merged);
            }
          }
      }
    }
  }

  for (const [tableName, entries] of tables.entries()) {
    const deduped = [];
    for (const entry of entries) {
      pushUnique(deduped, entry, (item) => `${item.method}:${item.path}`);
    }
    tables.set(tableName, deduped);
  }

  return tables;
}

function collectReferencedRouteTables(node, routeTables) {
  const seen = new Set();
  const referenced = new Set();
  const stack = [node];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (t.isIdentifier(current) && routeTables.has(current.name)) {
      referenced.add(current.name);
    }

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const entry of value) stack.push(entry);
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return [...referenced];
}

function collectFunctionDefinitions(ast) {
  const definitions = new Map();

  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name) {
        definitions.set(path.node.id.name, path.node);
      }
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const init = path.node.init;
      if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
        definitions.set(path.node.id.name, init);
      }
    },
  });

  return definitions;
}

function collectClassDefinitions(ast) {
  const definitions = new Map();

  function register(className, node) {
    definitions.set(className, buildClassDefinition(node));
  }

  traverse(ast, {
    ClassDeclaration(path) {
      if (path.node.id?.name) {
        register(path.node.id.name, path.node);
      }
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !t.isClassExpression(path.node.init)) return;
      register(path.node.id.name, path.node.init);
    },
  });

  return definitions;
}

function buildClassDefinition(node) {
  if (!t.isClassDeclaration(node) && !t.isClassExpression(node)) return null;
  const methods = new Map();
  let constructor = null;
  for (const element of node.body.body) {
    if (!t.isClassMethod(element) && !t.isClassPrivateMethod(element)) continue;
    if (element.kind === 'constructor') {
      constructor = element;
      continue;
    }
    if (t.isIdentifier(element.key)) {
      methods.set(element.key.name, element);
    }
  }
  return { constructor, methods };
}

function collectObjectLiteralDefinitions(ast) {
  const definitions = new Map();

  function register(name, node) {
    const methods = new Map();
    const thisBindings = new Map();

    for (const property of node.properties) {
      if (t.isObjectMethod(property) && t.isIdentifier(property.key)) {
        methods.set(property.key.name, property);
        continue;
      }

      if (!t.isObjectProperty(property)) continue;
      const keyName = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
      if (!keyName) continue;

      if (t.isFunctionExpression(property.value) || t.isArrowFunctionExpression(property.value)) {
        methods.set(keyName, property.value);
      } else {
        thisBindings.set(keyName, property.value);
      }
    }

    definitions.set(name, { methods, thisBindings });
  }

  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !t.isObjectExpression(path.node.init)) return;
      register(path.node.id.name, path.node.init);
    },
  });

  return definitions;
}

function buildObjectLiteralDefinition(node) {
  if (!t.isObjectExpression(node)) return null;
  const methods = new Map();
  const thisBindings = new Map();

  for (const property of node.properties) {
    if (t.isObjectMethod(property) && t.isIdentifier(property.key)) {
      methods.set(property.key.name, property);
      continue;
    }
    if (!t.isObjectProperty(property)) continue;
    const keyName = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
    if (!keyName) continue;
    if (t.isFunctionExpression(property.value) || t.isArrowFunctionExpression(property.value)) {
      methods.set(keyName, property.value);
    } else {
      thisBindings.set(keyName, property.value);
    }
  }

  return { methods, thisBindings };
}

function collectStaticLocalImports(ast, fromFile) {
  const imports = [];

  function pushImport(entry) {
    if (!entry?.source) return;
    imports.push(entry);
  }

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      const resolvedPath = resolveLocalModuleFile(source, fromFile);
      if (!resolvedPath) return;
      for (const specifier of path.node.specifiers) {
        if (t.isImportDefaultSpecifier(specifier)) {
          pushImport({ source, resolvedPath, localName: specifier.local.name, importName: 'default' });
        } else if (t.isImportSpecifier(specifier)) {
          pushImport({
            source,
            resolvedPath,
            localName: specifier.local.name,
            importName: t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value,
          });
        }
      }
    },
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!t.isCallExpression(init) || !t.isIdentifier(init.callee, { name: 'require' }) || !t.isStringLiteral(init.arguments[0])) {
        return;
      }
      const source = init.arguments[0].value;
      const resolvedPath = resolveLocalModuleFile(source, fromFile);
      if (!resolvedPath) return;

      if (t.isIdentifier(path.node.id)) {
        pushImport({ source, resolvedPath, localName: path.node.id.name, importName: 'default' });
        return;
      }

      if (t.isObjectPattern(path.node.id)) {
        for (const property of path.node.id.properties) {
          if (!t.isObjectProperty(property) || !t.isIdentifier(property.value)) continue;
          const importName = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
          if (!importName) continue;
          pushImport({ source, resolvedPath, localName: property.value.name, importName });
        }
      }
    },
  });

  return imports;
}

function cloneDefinitionMap(source) {
  return new Map(source ? [...source.entries()] : []);
}

function cloneRouteTables(source) {
  return new Map(
    source
      ? [...source.entries()].map(([name, entries]) => [name, Array.isArray(entries) ? [...entries] : entries])
      : [],
  );
}

function applyImportedSymbol(localName, exportedSymbol, state) {
  if (!localName || !exportedSymbol) return;
  if (exportedSymbol.kind === 'function') {
    state.functionDefinitions.set(localName, exportedSymbol.value);
    return;
  }
  if (exportedSymbol.kind === 'class') {
    state.classDefinitions.set(localName, exportedSymbol.value);
    return;
  }
  if (exportedSymbol.kind === 'object') {
    state.objectDefinitions.set(localName, exportedSymbol.value);
    return;
  }
  if (exportedSymbol.kind === 'routeTable') {
    state.routeTables.set(localName, [...(exportedSymbol.value ?? [])]);
  }
}

function resolveExportedSymbolByName(name, state) {
  if (!name) return null;
  if (state.functionDefinitions.has(name)) {
    return { kind: 'function', value: state.functionDefinitions.get(name) };
  }
  if (state.classDefinitions.has(name)) {
    return { kind: 'class', value: state.classDefinitions.get(name) };
  }
  if (state.objectDefinitions.has(name)) {
    return { kind: 'object', value: state.objectDefinitions.get(name) };
  }
  if (state.routeTables.has(name)) {
    return { kind: 'routeTable', value: state.routeTables.get(name) };
  }
  return null;
}

function resolveExportedSymbol(node, state) {
  if (!node) return null;
  if (t.isIdentifier(node)) {
    return resolveExportedSymbolByName(node.name, state);
  }
  if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node) || t.isObjectMethod(node)) {
    return { kind: 'function', value: node };
  }
  if (t.isClassDeclaration(node) || t.isClassExpression(node)) {
    const className = node.id?.name;
    if (className && state.classDefinitions.has(className)) {
      return { kind: 'class', value: state.classDefinitions.get(className) };
    }
    const definition = buildClassDefinition(node);
    return definition ? { kind: 'class', value: definition } : null;
  }
  if (t.isObjectExpression(node)) {
    return { kind: 'object', value: buildObjectLiteralDefinition(node) };
  }
  if (t.isArrayExpression(node)) {
    return { kind: 'routeTable', value: extractRouteTableEntriesFromNode(node, state.constants, state.functionDefinitions) };
  }
  if (t.isCallExpression(node)) {
    const callee = node.callee;
    if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && t.isIdentifier(callee.object)) {
      const tableName = callee.object.name;
      const methodName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
      if (methodName === 'concat' && state.routeTables.has(tableName)) {
        const merged = [...(state.routeTables.get(tableName) ?? [])];
        for (const argumentNode of node.arguments) {
          merged.push(...extractRouteTableEntriesFromNode(argumentNode, state.constants, state.functionDefinitions));
        }
        return { kind: 'routeTable', value: merged };
      }
    }
    const entries = extractRouteTableEntriesFromNode(node, state.constants, state.functionDefinitions);
    if (entries.length > 0) {
      return { kind: 'routeTable', value: entries };
    }
  }
  return null;
}

function collectModuleExports(ast, state) {
  const exportsMap = new Map();

  function registerExport(name, nodeOrName) {
    const symbol = typeof nodeOrName === 'string'
      ? resolveExportedSymbolByName(nodeOrName, state)
      : resolveExportedSymbol(nodeOrName, state);
    if (symbol) {
      exportsMap.set(name, symbol);
    }
  }

  traverse(ast, {
    ExportNamedDeclaration(path) {
      const declaration = path.node.declaration;
      if (declaration) {
        if (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) {
          if (declaration.id?.name) registerExport(declaration.id.name, declaration.id.name);
        } else if (t.isVariableDeclaration(declaration)) {
          for (const item of declaration.declarations) {
            if (t.isIdentifier(item.id)) registerExport(item.id.name, item.id.name);
          }
        }
      }

      for (const specifier of path.node.specifiers) {
        const localName = t.isIdentifier(specifier.local) ? specifier.local.name : null;
        const exportName = t.isIdentifier(specifier.exported) ? specifier.exported.name : specifier.exported.value;
        if (localName && exportName) registerExport(exportName, localName);
      }
    },
    ExportDefaultDeclaration(path) {
      registerExport('default', path.node.declaration);
    },
    AssignmentExpression(path) {
      const left = path.node.left;
      if (!t.isMemberExpression(left) && !t.isOptionalMemberExpression(left)) return;

      const objectName = memberPath(left.object);
      const propertyName = t.isIdentifier(left.property) ? left.property.name : memberPath(left.property);

      if (objectName === 'module.exports') {
        registerExport(propertyName ?? 'default', path.node.right);
        return;
      }

      if (objectName === 'module' && propertyName === 'exports') {
        if (t.isObjectExpression(path.node.right)) {
          for (const property of path.node.right.properties) {
            if (!t.isObjectProperty(property)) continue;
            const exportName = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
            if (!exportName) continue;
            registerExport(exportName, property.value);
          }
          if (!exportsMap.has('default')) {
            registerExport('default', path.node.right);
          }
          return;
        }
        registerExport('default', path.node.right);
        return;
      }

      if (objectName === 'exports') {
        registerExport(propertyName, path.node.right);
      }
    },
  });

  return exportsMap;
}

function loadLocalModuleInfo(filePath, moduleCache, depthRemaining = 2) {
  if (!filePath) return null;
  if (moduleCache.has(filePath)) return moduleCache.get(filePath);

  let code;
  try {
    code = readFileSync(filePath, 'utf8');
  } catch {
    moduleCache.set(filePath, null);
    return null;
  }

  const parsed = parse(code);
  if (!parsed.success) {
    moduleCache.set(filePath, null);
    return null;
  }

  const state = {
    code,
    filePath,
    ast: parsed.ast,
    functionDefinitions: cloneDefinitionMap(collectFunctionDefinitions(parsed.ast)),
    classDefinitions: cloneDefinitionMap(collectClassDefinitions(parsed.ast)),
    objectDefinitions: cloneDefinitionMap(collectObjectLiteralDefinitions(parsed.ast)),
    constants: null,
    routeTables: new Map(),
    exports: new Map(),
  };

  moduleCache.set(filePath, state);

  if (depthRemaining > 0) {
    const imports = collectStaticLocalImports(parsed.ast, filePath);
    for (const entry of imports) {
      const child = loadLocalModuleInfo(entry.resolvedPath, moduleCache, depthRemaining - 1);
      const symbol = child?.exports?.get(entry.importName);
      if (symbol) {
        applyImportedSymbol(entry.localName, symbol, state);
      }
    }
  }

  const constantBindings = resolveConstantBindings(parsed.ast);
  state.constants = new Map(constantBindings.map((entry) => [entry.name, entry.value]));
  state.routeTables = collectRouteTables(parsed.ast, state.constants, state.functionDefinitions, state.routeTables);
  state.exports = collectModuleExports(parsed.ast, state);
  return state;
}

function buildParameterBindings(params = [], args = []) {
  const bindings = new Map();
  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    if (t.isIdentifier(param)) {
      bindings.set(param.name, args[index] ?? null);
    }
  }
  return bindings;
}

function resolveContextExpression(node, context) {
  if (!node || !context) return null;

  if (t.isIdentifier(node) && context.params?.has(node.name)) {
    return context.params.get(node.name);
  }

  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && t.isThisExpression(node.object)) {
    const propertyName = t.isIdentifier(node.property) ? node.property.name : memberPath(node.property);
    if (propertyName && context.thisBindings?.has(propertyName)) {
      return context.thisBindings.get(propertyName);
    }
  }

  return null;
}

function buildClassInstanceBindings(classDefinition, args = []) {
  const bindings = new Map();
  const constructorNode = classDefinition?.constructor;
  if (!constructorNode || !t.isBlockStatement(constructorNode.body)) return bindings;

  const paramBindings = buildParameterBindings(constructorNode.params, args);
  for (const statement of constructorNode.body.body) {
    if (!t.isExpressionStatement(statement) || !t.isAssignmentExpression(statement.expression, { operator: '=' })) continue;
    const assignment = statement.expression;
    if (
      !(t.isMemberExpression(assignment.left) || t.isOptionalMemberExpression(assignment.left))
      || !t.isThisExpression(assignment.left.object)
    ) {
      continue;
    }

    const propertyName = t.isIdentifier(assignment.left.property) ? assignment.left.property.name : memberPath(assignment.left.property);
    if (!propertyName) continue;

    if (t.isIdentifier(assignment.right) && paramBindings.has(assignment.right.name)) {
      bindings.set(propertyName, paramBindings.get(assignment.right.name));
    } else {
      bindings.set(propertyName, assignment.right);
    }
  }

  return bindings;
}

function resolveHelperReturn(callNode, {
  functionDefinitions,
  classDefinitions,
  objectDefinitions,
  classInstances,
  context,
  depth = 0,
}) {
  if (!t.isCallExpression(callNode) || depth > 4) return null;

  if (t.isIdentifier(callNode.callee) && functionDefinitions.has(callNode.callee.name)) {
    const functionNode = functionDefinitions.get(callNode.callee.name);
    const returnExpression = getFunctionReturnExpression(functionNode);
    if (!returnExpression) return null;
    return {
      expression: returnExpression,
      context: {
        params: buildParameterBindings(functionNode.params, callNode.arguments),
        thisBindings: context?.thisBindings ?? new Map(),
      },
    };
  }

  if (t.isMemberExpression(callNode.callee) || t.isOptionalMemberExpression(callNode.callee)) {
    const objectNode = callNode.callee.object;
    const propertyName = t.isIdentifier(callNode.callee.property) ? callNode.callee.property.name : memberPath(callNode.callee.property);
    if (!propertyName) return null;

    if (t.isIdentifier(objectNode) && classInstances.has(objectNode.name)) {
      const instance = classInstances.get(objectNode.name);
      const classDefinition = classDefinitions.get(instance.className);
      const methodNode = classDefinition?.methods?.get(propertyName);
      const returnExpression = getFunctionReturnExpression(methodNode);
      if (!returnExpression) return null;
      return {
        expression: returnExpression,
        context: {
          params: buildParameterBindings(methodNode.params, callNode.arguments),
          thisBindings: instance.thisBindings,
        },
      };
    }

    if (t.isIdentifier(objectNode) && objectDefinitions.has(objectNode.name)) {
      const objectDefinition = objectDefinitions.get(objectNode.name);
      const methodNode = objectDefinition?.methods?.get(propertyName);
      const returnExpression = getFunctionReturnExpression(methodNode);
      if (!returnExpression) return null;
      return {
        expression: returnExpression,
        context: {
          params: buildParameterBindings(methodNode.params, callNode.arguments),
          thisBindings: objectDefinition.thisBindings,
        },
      };
    }
  }

  return null;
}

function getFunctionBodyStatements(node) {
  if (!node) return [];
  if (
    t.isFunctionDeclaration(node)
    || t.isFunctionExpression(node)
    || t.isArrowFunctionExpression(node)
    || t.isObjectMethod(node)
    || t.isClassMethod(node)
    || t.isClassPrivateMethod(node)
  ) {
    if (t.isBlockStatement(node.body)) return node.body.body;
  }
  return [];
}

function matchRequestField(node, reqName, aliasMap) {
  if (!node) return null;

  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const objectName = memberPath(node.object);
    const propertyName = t.isIdentifier(node.property) ? node.property.name : memberPath(node.property);
    if (objectName === reqName && (propertyName === 'url' || propertyName === 'method')) {
      return propertyName;
    }
    if (objectName && aliasMap.has(objectName) && propertyName === 'pathname') {
      return 'url';
    }
  }

  if (t.isIdentifier(node) && aliasMap.has(node.name)) {
    return aliasMap.get(node.name);
  }

  return null;
}

function resolveAliasField(node, reqName, aliasMap) {
  if (!node) return null;
  if (t.isIdentifier(node) && aliasMap.has(node.name)) return aliasMap.get(node.name);
  return matchRequestField(node, reqName, aliasMap);
}

function extractNodeHttpConstraints(testNode, reqName, constants, aliasMap, functionDefinitions) {
  if (!testNode) return [];

  if (t.isLogicalExpression(testNode)) {
    if (testNode.operator === '&&') {
      const left = extractNodeHttpConstraints(testNode.left, reqName, constants, aliasMap, functionDefinitions);
      const right = extractNodeHttpConstraints(testNode.right, reqName, constants, aliasMap, functionDefinitions);
      if (left.length === 0) return right;
      if (right.length === 0) return left;
      const merged = [];
      for (const leftEntry of left) {
        for (const rightEntry of right) {
          merged.push({
            method: rightEntry.method ?? leftEntry.method ?? null,
            path: rightEntry.path ?? leftEntry.path ?? null,
          });
        }
      }
      return merged;
    }

    if (testNode.operator === '||') {
      return [
        ...extractNodeHttpConstraints(testNode.left, reqName, constants, aliasMap, functionDefinitions),
        ...extractNodeHttpConstraints(testNode.right, reqName, constants, aliasMap, functionDefinitions),
      ];
    }
  }

  if (t.isBinaryExpression(testNode) && ['==', '==='].includes(testNode.operator)) {
    const leftField = resolveAliasField(testNode.left, reqName, aliasMap);
    const rightField = resolveAliasField(testNode.right, reqName, aliasMap);
    const leftValue = getResolvedStringWithHelpers(testNode.left, constants, functionDefinitions);
    const rightValue = getResolvedStringWithHelpers(testNode.right, constants, functionDefinitions);

    if (leftField && rightValue) {
      return [{
        method: leftField === 'method' ? rightValue.toUpperCase() : null,
        path: leftField === 'url' ? rightValue : null,
      }];
    }

    if (rightField && leftValue) {
      return [{
        method: rightField === 'method' ? leftValue.toUpperCase() : null,
        path: rightField === 'url' ? leftValue : null,
      }];
    }
  }

  if (t.isCallExpression(testNode)) {
    const callee = testNode.callee;
    if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
      const field = resolveAliasField(callee.object, reqName, aliasMap);
      const methodName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
      const argumentValue = getResolvedStringWithHelpers(testNode.arguments[0], constants, functionDefinitions);
      if (field === 'url' && methodName === 'startsWith' && argumentValue) {
        return [{
          method: null,
          path: argumentValue.endsWith('*') ? argumentValue : `${argumentValue}*`,
        }];
      }
      if (field === 'url' && methodName === 'includes' && argumentValue) {
        return [{
          method: null,
          path: `*${argumentValue}*`,
        }];
      }
    }
  }

  return [];
}

function collectNodeHttpRoutes(handlerNode, {
  container,
  constants,
  functionDefinitions,
  routeTables,
  functionName = null,
}) {
  const statements = getFunctionBodyStatements(handlerNode);
  if (statements.length === 0) return [];

  const reqParam = handlerNode.params?.[0];
  const reqName = t.isIdentifier(reqParam) ? reqParam.name : 'req';
  const aliasMap = new Map();
  const routes = [];

  const register = (constraint, location) => {
    if (!constraint || (!constraint.path && !constraint.method)) return;
    routes.push({
      framework: 'node-http',
      container,
      method: constraint.method ?? 'ANY',
      path: constraint.path ?? null,
      handler: functionName ?? inferCallableName(handlerNode),
      location,
    });
  };

  const registerRouteTableEntries = (node, inherited, location) => {
    const tableNames = collectReferencedRouteTables(node, routeTables);
    for (const tableName of tableNames) {
      for (const entry of routeTables.get(tableName) ?? []) {
        register({
          method: entry.method ?? inherited.method ?? null,
          path: entry.path ?? inherited.path ?? null,
        }, location);
      }
    }
  };

  const visitStatement = (statement, inherited = { method: null, path: null }) => {
    if (!statement) return;

    if (t.isBlockStatement(statement)) {
      for (const entry of statement.body) {
        visitStatement(entry, inherited);
      }
      return;
    }

    if (t.isVariableDeclaration(statement)) {
      for (const declaration of statement.declarations) {
        if (!declaration.init) continue;
        if (t.isIdentifier(declaration.id)) {
          if (t.isMemberExpression(declaration.init) || t.isOptionalMemberExpression(declaration.init)) {
            const field = matchRequestField(declaration.init, reqName, aliasMap);
            if (field) {
              aliasMap.set(declaration.id.name, field);
              continue;
            }
          }
          if (t.isNewExpression(declaration.init) && memberPath(declaration.init.callee) === 'URL') {
            const sourceField = matchRequestField(declaration.init.arguments[0], reqName, aliasMap);
            if (sourceField === 'url') {
              aliasMap.set(declaration.id.name, 'url');
            }
          }
          registerRouteTableEntries(declaration.init, inherited, literalLocation(declaration));
          continue;
        }

        if (t.isObjectPattern(declaration.id) && t.isIdentifier(declaration.init, { name: reqName })) {
          for (const property of declaration.id.properties) {
            if (!t.isObjectProperty(property) || !t.isIdentifier(property.value)) continue;
            const keyName = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
            if (keyName === 'url' || keyName === 'method') {
              aliasMap.set(property.value.name, keyName);
            }
          }
          continue;
        }

        if (
          t.isObjectPattern(declaration.id)
          && t.isNewExpression(declaration.init)
          && memberPath(declaration.init.callee) === 'URL'
          && matchRequestField(declaration.init.arguments[0], reqName, aliasMap) === 'url'
        ) {
          for (const property of declaration.id.properties) {
            if (!t.isObjectProperty(property) || !t.isIdentifier(property.value)) continue;
            const keyName = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
            if (keyName === 'pathname' || keyName === 'url') {
              aliasMap.set(property.value.name, 'url');
            }
          }
        }
      }
      return;
    }

    if (t.isExpressionStatement(statement)) {
      registerRouteTableEntries(statement.expression, inherited, literalLocation(statement));
      return;
    }

    if (t.isIfStatement(statement)) {
      const branches = extractNodeHttpConstraints(statement.test, reqName, constants, aliasMap, functionDefinitions);
      if (branches.length > 0) {
        for (const branch of branches) {
          const nextConstraint = {
            method: branch.method ?? inherited.method ?? null,
            path: branch.path ?? inherited.path ?? null,
          };
          register(nextConstraint, literalLocation(statement));
          visitStatement(statement.consequent, nextConstraint);
        }
      } else {
        visitStatement(statement.consequent, inherited);
      }
      if (statement.alternate) {
        visitStatement(statement.alternate, inherited);
      }
      return;
    }

    if (t.isSwitchStatement(statement)) {
      const field = matchRequestField(statement.discriminant, reqName, aliasMap);
      for (const caseNode of statement.cases) {
        const caseValue = caseNode.test ? getResolvedString(caseNode.test, constants) : null;
        const nextConstraint = {
          method: field === 'method' && caseValue ? caseValue.toUpperCase() : inherited.method,
          path: field === 'url' && caseValue ? caseValue : inherited.path,
        };
        if (field && caseValue) {
          register(nextConstraint, literalLocation(caseNode));
        }
        for (const consequent of caseNode.consequent) {
          visitStatement(consequent, nextConstraint);
        }
      }
    }
  };

  for (const statement of statements) {
    visitStatement(statement);
  }

  const deduped = [];
  for (const route of routes) {
    pushRouteRecord(deduped, route);
  }
  return deduped;
}

function classifyWebSocketConstructor(callee) {
  if (!callee) return null;
  if (
    callee === 'WebSocket'
    || callee === 'ws'
    || callee === 'ws.WebSocket'
    || callee === 'socket.io-client.io'
    || callee === 'socket.io-client.Manager'
  ) {
    return {
      kind: 'client',
      transport: callee.startsWith('socket.io-client') ? 'socket.io' : 'ws',
    };
  }

  if (
    callee === 'ws.WebSocketServer'
    || callee === 'ws.Server'
    || callee === 'WebSocket.Server'
    || callee === 'socket.io.Server'
  ) {
    return {
      kind: 'server',
      transport: callee.startsWith('socket.io') ? 'socket.io' : 'ws',
    };
  }

  return null;
}

function extractWebSocketTarget(constructorInfo, args, constants) {
  if (!constructorInfo) return null;
  if (constructorInfo.kind === 'client') {
    return getResolvedString(args?.[0], constants);
  }

  if (constructorInfo.transport === 'socket.io') {
    return getObjectString(args?.[1], ['path'], constants) ?? getObjectString(args?.[0], ['path'], constants);
  }

  return getObjectString(args?.[0], ['path'], constants);
}

function resolveWebSocketContainer(node, websocketContainers, constants, helperContext = {}) {
  if (!node || (helperContext.depth ?? 0) > 4) return null;

  const contextualNode = resolveContextExpression(node, helperContext.context);
  if (contextualNode) {
    return resolveWebSocketContainer(contextualNode, websocketContainers, constants, {
      ...helperContext,
      depth: (helperContext.depth ?? 0) + 1,
    });
  }

  if (t.isIdentifier(node)) {
    const existing = websocketContainers.get(node.name);
    return existing ? { ...existing, name: node.name } : null;
  }

  if (t.isCallExpression(node)) {
    const helperReturn = resolveHelperReturn(node, helperContext);
    if (helperReturn) {
      return resolveWebSocketContainer(helperReturn.expression, websocketContainers, constants, {
        ...helperContext,
        context: helperReturn.context,
        depth: (helperContext.depth ?? 0) + 1,
      });
    }

    const callee = node.callee;
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return null;
    const propertyName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
    const parent = resolveWebSocketContainer(callee.object, websocketContainers, constants, helperContext);
    if (!parent) return null;
    if (propertyName === 'of') {
      const namespace = getResolvedStringInContext(
        node.arguments[0],
        constants,
        helperContext.functionDefinitions ?? new Map(),
        helperContext.context ?? null,
      );
      return {
        ...parent,
        namespace,
        target: joinRoutePath(parent.target, namespace),
      };
    }
    if (WEBSOCKET_ROOM_CHAIN_METHODS.has(propertyName)) {
      const room = getResolvedStringInContext(
        node.arguments[0],
        constants,
        helperContext.functionDefinitions ?? new Map(),
        helperContext.context ?? null,
      );
      return {
        ...parent,
        room,
      };
    }
    return null;
  }

  return null;
}

function resolveGraphqlMiddlewareContainer(node, graphqlMiddlewareContainers, constants, helperContext = {}) {
  if (!node || (helperContext.depth ?? 0) > 4) return null;

  const contextualNode = resolveContextExpression(node, helperContext.context);
  if (contextualNode) {
    return resolveGraphqlMiddlewareContainer(contextualNode, graphqlMiddlewareContainers, constants, {
      ...helperContext,
      depth: (helperContext.depth ?? 0) + 1,
    });
  }

  if (t.isIdentifier(node)) {
    const existing = graphqlMiddlewareContainers.get(node.name);
    return existing ? { ...existing, name: node.name } : null;
  }

  if (t.isCallExpression(node)) {
    const helperReturn = resolveHelperReturn(node, helperContext);
    if (helperReturn) {
      return resolveGraphqlMiddlewareContainer(helperReturn.expression, graphqlMiddlewareContainers, constants, {
        ...helperContext,
        context: helperReturn.context,
        depth: (helperContext.depth ?? 0) + 1,
      });
    }

    const calleeName = helperContext.bindings ? expandBindingName(memberPath(node.callee), helperContext.bindings) : memberPath(node.callee);
    const graphqlKind = classifyGraphQLCall(calleeName);
    if (graphqlKind && graphqlKind !== 'graphql-execute' && graphqlKind !== 'graphql-client' && graphqlKind !== 'graphql-mercurius') {
      return {
        kind: graphqlKind,
        target: extractGraphqlTarget(
          node.arguments,
          graphqlKind,
          constants,
          helperContext.functionDefinitions ?? new Map(),
          helperContext.context ?? null,
        ),
      };
    }
  }

  return null;
}

function resolveNestedSocketContext(node, baseContext, socketName, constants) {
  if (!node) return null;
  if (t.isIdentifier(node) && node.name === socketName) {
    return { ...baseContext };
  }
  if (t.isCallExpression(node)) {
    const callee = node.callee;
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return null;
    const propertyName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
    const parent = resolveNestedSocketContext(callee.object, baseContext, socketName, constants);
    if (!parent) return null;
    if (WEBSOCKET_ROOM_CHAIN_METHODS.has(propertyName)) {
      return {
        ...parent,
        room: getResolvedString(node.arguments[0], constants),
      };
    }
    return null;
  }
  return null;
}

function getFunctionLikeNode(node, functionDefinitions) {
  if (!node) return null;
  if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    return node;
  }
  if (t.isIdentifier(node)) {
    return functionDefinitions.get(node.name) ?? null;
  }
  return null;
}

function collectNestedWebSocketEvents(handlerNode, {
  socketName,
  transport,
  target,
  container,
  namespace = null,
  functionDefinitions,
  constants,
  collection,
}) {
  if (!handlerNode || !socketName || !t.isBlockStatement(handlerNode.body)) return;

  traverse(handlerNode.body, {
    noScope: true,
    Function(path) {
      if (path.node !== handlerNode) {
        path.skip();
      }
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return;
      const propertyName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
      if (!propertyName) return;
      const socketContext = resolveNestedSocketContext(callee.object, {
        transport,
        target,
        container,
        namespace,
        room: null,
      }, socketName, constants);
      if (!socketContext) return;

      const eventName = getResolvedString(path.node.arguments[0], constants);
      const location = literalLocation(path.node);

      if (WEBSOCKET_LISTENER_METHODS.has(propertyName) && eventName) {
        pushUnique(collection, {
          kind: 'listener',
          api: `${socketContext.transport}.${propertyName}`,
          container: socketContext.container,
          target: socketContext.target,
          event: eventName,
          handler: inferCallableName(path.node.arguments[1]),
          namespace: socketContext.namespace ?? null,
          room: socketContext.room ?? null,
          location,
        }, (item) => `${item.kind}:${item.api}:${item.container}:${item.target}:${item.event}:${item.location.line}:${item.location.column}`);

        const nestedHandler = getFunctionLikeNode(path.node.arguments[1], functionDefinitions);
        if (nestedHandler && eventName === 'connection' && nestedHandler.params?.[0] && t.isIdentifier(nestedHandler.params[0])) {
          collectNestedWebSocketEvents(nestedHandler, {
            socketName: nestedHandler.params[0].name,
            transport,
            target,
            container,
            namespace,
            functionDefinitions,
            constants,
            collection,
          });
        }
        return;
      }

      if (WEBSOCKET_MIDDLEWARE_METHODS.has(propertyName)) {
        pushUnique(collection, {
          kind: 'middleware',
          api: `${socketContext.transport}.${propertyName}`,
          container: socketContext.container,
          target: socketContext.target,
          handler: inferCallableName(path.node.arguments[0]),
          namespace: socketContext.namespace ?? null,
          room: socketContext.room ?? null,
          location,
        }, (item) => `${item.kind}:${item.api}:${item.container}:${item.target}:${item.handler}:${item.location.line}:${item.location.column}`);
        return;
      }

      if (WEBSOCKET_ROOM_STATE_METHODS.has(propertyName)) {
        pushUnique(collection, {
          kind: propertyName === 'join' ? 'room-join' : 'room-leave',
          api: `${socketContext.transport}.${propertyName}`,
          container: socketContext.container,
          target: socketContext.target,
          event: null,
          namespace: socketContext.namespace ?? null,
          room: getResolvedString(path.node.arguments[0], constants),
          location,
        }, (item) => `${item.kind}:${item.api}:${item.container}:${item.target}:${item.room}:${item.location.line}:${item.location.column}`);
        return;
      }

      if (WEBSOCKET_EMIT_METHODS.has(propertyName)) {
        pushUnique(collection, {
          kind: propertyName === 'emit' ? 'emit' : 'send',
          api: `${socketContext.transport}.${propertyName}`,
          container: socketContext.container,
          target: socketContext.target,
          event: propertyName === 'emit' ? eventName : null,
          namespace: socketContext.namespace ?? null,
          room: socketContext.room ?? null,
          location,
        }, (item) => `${item.kind}:${item.api}:${item.container}:${item.target}:${item.event}:${item.location.line}:${item.location.column}`);
      }
    },
  });
}

function collectHapiRoutes(node, { framework, container, location, constants }) {
  const routeNodes = t.isArrayExpression(node) ? node.elements.filter(Boolean) : [node];
  const routes = [];
  for (const routeNode of routeNodes) {
    if (!t.isObjectExpression(routeNode)) continue;
    const pathValue = getObjectString(routeNode, ['path'], constants);
    const methods = getObjectArray(routeNode, ['method'], constants);
    const handlerNode = findObjectProperty(routeNode, ['handler']);
    for (const method of methods.length > 0 ? methods : ['ROUTE']) {
      routes.push({
        framework,
        container,
        method,
        path: pathValue,
        handler: inferCallableName(handlerNode),
        location,
      });
    }
  }
  return routes;
}

function resolveNodeValue(node, constants, depth = 0) {
  if (!node || depth > 6) return { resolved: false, value: undefined, kind: 'unresolved' };

  if (t.isStringLiteral(node)) return { resolved: true, value: node.value, kind: 'string' };
  if (t.isNumericLiteral(node)) return { resolved: true, value: node.value, kind: 'number' };
  if (t.isBooleanLiteral(node)) return { resolved: true, value: node.value, kind: 'boolean' };
  if (t.isNullLiteral(node)) return { resolved: true, value: null, kind: 'null' };

  if (t.isIdentifier(node)) {
    if (!constants.has(node.name)) return { resolved: false, value: undefined, kind: 'identifier' };
    return { resolved: true, value: constants.get(node.name), kind: 'binding' };
  }

  if (t.isArrayExpression(node)) {
    const output = [];
    for (const element of node.elements) {
      if (!element) {
        output.push(null);
        continue;
      }
      const resolved = resolveNodeValue(element, constants, depth + 1);
      if (!resolved.resolved) return { resolved: false, value: undefined, kind: 'array' };
      output.push(stableValue(resolved.value));
    }
    return { resolved: true, value: output, kind: 'array' };
  }

  if (t.isObjectExpression(node)) {
    const output = {};
    for (const property of node.properties) {
      if (!t.isObjectProperty(property)) return { resolved: false, value: undefined, kind: 'object' };
      const key = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null;
      if (!key) return { resolved: false, value: undefined, kind: 'object' };
      const resolved = resolveNodeValue(property.value, constants, depth + 1);
      if (!resolved.resolved) return { resolved: false, value: undefined, kind: 'object' };
      output[key] = stableValue(resolved.value);
    }
    return { resolved: true, value: output, kind: 'object' };
  }

  if (t.isTemplateLiteral(node)) {
    let value = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      value += node.quasis[index].value.cooked ?? '';
      if (index < node.expressions.length) {
        const resolved = resolveNodeValue(node.expressions[index], constants, depth + 1);
        if (!resolved.resolved || typeof resolved.value === 'object') {
          return { resolved: false, value: undefined, kind: 'template' };
        }
        value += String(resolved.value);
      }
    }
    return { resolved: true, value, kind: 'template' };
  }

  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = resolveNodeValue(node.left, constants, depth + 1);
    const right = resolveNodeValue(node.right, constants, depth + 1);
    if (!left.resolved || !right.resolved) return { resolved: false, value: undefined, kind: 'binary' };
    if (typeof left.value === 'object' || typeof right.value === 'object') return { resolved: false, value: undefined, kind: 'binary' };
    return {
      resolved: true,
      value: typeof left.value === 'string' || typeof right.value === 'string'
        ? `${left.value}${right.value}`
        : Number(left.value) + Number(right.value),
      kind: 'binary',
    };
  }

  if (t.isMemberExpression(node)) {
    const object = resolveNodeValue(node.object, constants, depth + 1);
    const property = node.computed
      ? resolveNodeValue(node.property, constants, depth + 1)
      : { resolved: true, value: t.isIdentifier(node.property) ? node.property.name : memberPath(node.property), kind: 'property' };

    if (!object.resolved || !property.resolved) return { resolved: false, value: undefined, kind: 'member' };

    if (Array.isArray(object.value) && Number.isInteger(Number(property.value))) {
      return {
        resolved: true,
        value: object.value[Number(property.value)],
        kind: 'array-member',
      };
    }

    if (object.value && typeof object.value === 'object' && property.value in object.value) {
      return {
        resolved: true,
        value: object.value[property.value],
        kind: 'object-member',
      };
    }
  }

  if (t.isCallExpression(node)) {
    const callee = memberPath(node.callee);

    if (callee === 'Buffer.from' && node.arguments.length >= 1) {
      const value = resolveNodeValue(node.arguments[0], constants, depth + 1);
      const encoding = node.arguments[1] ? resolveNodeValue(node.arguments[1], constants, depth + 1) : { resolved: true, value: 'utf8' };
      if (value.resolved && encoding.resolved && typeof value.value === 'string' && typeof encoding.value === 'string') {
        return {
          resolved: true,
          value: Buffer.from(value.value, encoding.value).toString('utf8'),
          kind: 'buffer-from',
        };
      }
    }

    if (callee === 'atob' && node.arguments.length >= 1) {
      const value = resolveNodeValue(node.arguments[0], constants, depth + 1);
      if (value.resolved && typeof value.value === 'string') {
        return {
          resolved: true,
          value: Buffer.from(value.value, 'base64').toString('utf8'),
          kind: 'atob',
        };
      }
    }

    if (t.isMemberExpression(node.callee) && memberPath(node.callee.property) === 'toString') {
      const base = resolveNodeValue(node.callee.object, constants, depth + 1);
      const encoding = node.arguments[0] ? resolveNodeValue(node.arguments[0], constants, depth + 1) : { resolved: true, value: 'utf8' };
      if (base.resolved && encoding.resolved && typeof base.value === 'string' && typeof encoding.value === 'string') {
        return {
          resolved: true,
          value: base.value,
          kind: 'buffer-decode',
        };
      }
    }
  }

  if (t.isNewExpression(node)) {
    const callee = memberPath(node.callee);

    if (callee === 'URL' && node.arguments.length >= 1) {
      const value = resolveNodeValue(node.arguments[0], constants, depth + 1);
      const base = node.arguments[1] ? resolveNodeValue(node.arguments[1], constants, depth + 1) : null;
      if (value.resolved && typeof value.value === 'string' && (!base || (base.resolved && typeof base.value === 'string'))) {
        try {
          return {
            resolved: true,
            value: new URL(value.value, base?.value).toString(),
            kind: 'url',
          };
        } catch {
          return { resolved: false, value: undefined, kind: 'url' };
        }
      }
    }
  }

  return { resolved: false, value: undefined, kind: 'unresolved' };
}

function resolveConstantBindings(ast) {
  const declarations = [];

  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      if (!['const', 'let', 'var'].includes(path.parent.kind)) return;
      declarations.push({
        name: path.node.id.name,
        init: path.node.init,
        kind: path.parent.kind,
        node: path.node,
      });
    },
  });

  const constants = new Map();
  let changed = true;
  let rounds = 0;

  while (changed && rounds < 6) {
    changed = false;
    rounds += 1;

    for (const declaration of declarations) {
      if (!declaration.init) continue;
      const resolved = resolveNodeValue(declaration.init, constants, 0);
      if (!resolved.resolved) continue;
      const nextValue = stableValue(resolved.value);
      const previous = constants.get(declaration.name);
      const prevJson = JSON.stringify(previous);
      const nextJson = JSON.stringify(nextValue);
      if (prevJson !== nextJson) {
        constants.set(declaration.name, nextValue);
        changed = true;
      }
    }
  }

  return declarations
    .filter((declaration) => constants.has(declaration.name))
    .map((declaration) => ({
      name: declaration.name,
      kind: declaration.kind,
      value: constants.get(declaration.name),
      location: literalLocation(declaration.node),
    }));
}

export function deobfuscateNodeLiterals(code) {
  const parsed = parse(code);
  if (!parsed.success) {
    return { success: false, error: parsed.error };
  }

  const constantBindings = resolveConstantBindings(parsed.ast);
  const constantMap = new Map(constantBindings.map((entry) => [entry.name, entry.value]));
  const resolvedExpressions = [];
  const decodedStrings = [];
  const stringArrays = [];

  for (const binding of constantBindings) {
    if (Array.isArray(binding.value) && binding.value.every((entry) => typeof entry === 'string')) {
      stringArrays.push({
        name: binding.name,
        size: binding.value.length,
        preview: binding.value.slice(0, 8),
        location: binding.location,
      });
    }
  }

  traverse(parsed.ast, {
    enter(path) {
      if (
        t.isBinaryExpression(path.node) ||
        t.isTemplateLiteral(path.node) ||
        t.isMemberExpression(path.node) ||
        t.isCallExpression(path.node)
      ) {
        const resolved = resolveNodeValue(path.node, constantMap, 0);
        if (!resolved.resolved || typeof resolved.value === 'object' || resolved.value === undefined) {
          return;
        }

        const codePreview = code.slice(path.node.start ?? 0, path.node.end ?? 0);
        resolvedExpressions.push({
          kind: resolved.kind,
          original: codePreview.length > 120 ? `${codePreview.slice(0, 117)}...` : codePreview,
          value: String(resolved.value),
          location: literalLocation(path.node),
        });

        if (typeof resolved.value === 'string') {
          decodedStrings.push(String(resolved.value));
        }
      }
    },
  });

  const uniqueDecodedStrings = [...new Set(decodedStrings)].slice(0, 120);
  const uniqueExpressions = [];
  const seenExpression = new Set();
  for (const entry of resolvedExpressions) {
    const key = `${entry.kind}:${entry.original}:${entry.value}:${entry.location.line}:${entry.location.column}`;
    if (seenExpression.has(key)) continue;
    seenExpression.add(key);
    uniqueExpressions.push(entry);
  }

  return {
    success: true,
    data: {
      constantBindings: constantBindings.slice(0, 80),
      stringArrays: stringArrays.slice(0, 40),
      resolvedExpressions: uniqueExpressions.slice(0, 120),
      decodedStrings: uniqueDecodedStrings,
    },
  };
}

function pushUnique(list, item, keyFn = (value) => JSON.stringify(value)) {
  const key = keyFn(item);
  if (list._seen?.has(key)) return;
  if (!list._seen) list._seen = new Set();
  list._seen.add(key);
  list.push(item);
}

export function analyzeNodeProfile(code, options = {}) {
  const parsed = parse(code);
  if (!parsed.success) {
    return { success: false, error: parsed.error };
  }

  const analysisTarget = normalizeAnalysisTarget(options?.target ?? options?.filePath ?? null);
  const { bindings, dependencies } = buildImportBindings(parsed.ast);
  const functionDefinitions = collectFunctionDefinitions(parsed.ast);
  const classDefinitions = collectClassDefinitions(parsed.ast);
  const objectDefinitions = collectObjectLiteralDefinitions(parsed.ast);
  const constantBindings = resolveConstantBindings(parsed.ast);
  const constantMap = new Map(constantBindings.map((entry) => [entry.name, entry.value]));
  const routeTables = collectRouteTables(parsed.ast, constantMap, functionDefinitions);
  const imports = [];
  const builtinModulesUsed = new Set();
  const externalModules = new Set();
  const relativeModules = new Set();
  const dynamicImports = [];
  const processSignals = {
    envKeys: [],
    argvAccesses: [],
    cwdAccesses: [],
    exitCalls: [],
  };
  const filesystem = [];
  const network = [];
  const httpClients = [];
  const servers = {
    frameworks: new Set(),
    entrypoints: [],
    routes: [],
  };
  const subprocess = [];
  const dynamicCode = [];
  const crypto = [];
  const nativeAddons = [];
  const webassembly = [];
  const workers = [];
  const cluster = [];
  const moduleLoading = [];
  const websockets = [];
  const graphql = [];
  const persistence = [];
  const cli = {
    frameworks: [],
    shebang: code.startsWith('#!'),
  };
  const routeContainers = new Map();
  const routeBuilderContainers = new Map();
  const routeMounts = new Map();
  const routePrefixes = new Map();
  const httpClientContainers = new Map();
  const graphqlClientContainers = new Map();
  const graphqlServerContainers = new Map();
  const graphqlMiddlewareContainers = new Map();
  const websocketContainers = new Map();
  const classInstances = new Map();
  const nodeHttpHandlers = [];
  const rawRouteRecords = [];

  if (analysisTarget) {
    const moduleCache = new Map();
    const localImports = collectStaticLocalImports(parsed.ast, analysisTarget);
    for (const entry of localImports) {
      const moduleInfo = loadLocalModuleInfo(entry.resolvedPath, moduleCache, Number(options?.maxLocalModuleDepth ?? 2));
      if (moduleInfo) {
        for (const [name, node] of moduleInfo.functionDefinitions.entries()) {
          if (!functionDefinitions.has(name)) functionDefinitions.set(name, node);
        }
        for (const [name, node] of moduleInfo.classDefinitions.entries()) {
          if (!classDefinitions.has(name)) classDefinitions.set(name, node);
        }
        for (const [name, node] of moduleInfo.objectDefinitions.entries()) {
          if (!objectDefinitions.has(name)) objectDefinitions.set(name, node);
        }
        for (const [name, entries] of moduleInfo.routeTables.entries()) {
          if (!routeTables.has(name)) routeTables.set(name, [...entries]);
        }
      }
      const symbol = moduleInfo?.exports?.get(entry.importName);
      if (symbol) {
        applyImportedSymbol(entry.localName, symbol, {
          functionDefinitions,
          classDefinitions,
          objectDefinitions,
          routeTables,
        });
      }
    }
  }

  const refreshedRouteTables = collectRouteTables(parsed.ast, constantMap, functionDefinitions, routeTables);
  for (const [name, entries] of refreshedRouteTables.entries()) {
    routeTables.set(name, entries);
  }

  function registerModule(source, kind, location, detail = {}) {
    const moduleType = classifyModuleSource(source);
    const record = {
      source,
      kind,
      moduleType,
      location,
      ...detail,
    };
    imports.push(record);
    if (moduleType === 'builtin') builtinModulesUsed.add(String(source).replace(/^node:/, ''));
    if (moduleType === 'external') externalModules.add(source);
    if (moduleType === 'relative') relativeModules.add(source);
  }

  for (const dependency of dependencies) {
    registerModule(dependency.source, dependency.imported ? 'binding' : 'module-binding', null, {
      binding: dependency.binding,
      imported: dependency.imported,
    });
    const sourceName = String(dependency.source).replace(/^node:/, '');
    if (CLI_FRAMEWORKS.has(sourceName)) {
      cli.frameworks.push(sourceName);
    }
    if (SERVER_FRAMEWORK_MODULES.has(sourceName)) {
      servers.frameworks.add(normalizeFrameworkName(sourceName));
    }
  }

  traverse(parsed.ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !path.node.init) return;
      const name = path.node.id.name;
      const init = path.node.init;
      const location = literalLocation(path.node);

      if (t.isCallExpression(init)) {
        const callee = expandBindingName(memberPath(init.callee), bindings);
        const websocketContainer = resolveWebSocketContainer(init, websocketContainers, constantMap, {
          functionDefinitions,
          classDefinitions,
          objectDefinitions,
          classInstances,
          bindings,
        });
        const graphqlKind = classifyGraphQLCall(callee);
        const graphqlMiddleware = resolveGraphqlMiddlewareContainer(init, graphqlMiddlewareContainers, constantMap, {
          functionDefinitions,
          classDefinitions,
          objectDefinitions,
          classInstances,
          bindings,
        });
        if (callee === 'express') {
          routeContainers.set(name, 'express');
          servers.frameworks.add('express');
          pushUnique(servers.entrypoints, { name, framework: 'express', kind: 'app', location }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
        } else if (callee === 'express.Router' || callee === '@koa/router' || callee === 'koa-router') {
          const framework = callee === 'express.Router' ? 'express-router' : 'koa-router';
          routeContainers.set(name, framework);
          servers.frameworks.add(framework);
          pushUnique(servers.entrypoints, { name, framework, kind: 'router', location }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
        } else if (callee === 'fastify') {
          routeContainers.set(name, 'fastify');
          servers.frameworks.add('fastify');
          pushUnique(servers.entrypoints, { name, framework: 'fastify', kind: 'app', location }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
        } else if (callee === 'restify.createServer') {
          routeContainers.set(name, 'restify');
          servers.frameworks.add('restify');
          pushUnique(servers.entrypoints, { name, framework: 'restify', kind: 'app', location }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
        } else if (callee === '@hapi/hapi.server') {
          routeContainers.set(name, 'hapi');
          servers.frameworks.add('hapi');
          pushUnique(servers.entrypoints, { name, framework: 'hapi', kind: 'app', location }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
        } else if (/^(?:http|https|node:http|node:https)\.createServer$/.test(callee ?? '')) {
          routeContainers.set(name, 'node-http');
          servers.frameworks.add('node-http');
          const targetName = t.isIdentifier(init.arguments[0]) ? init.arguments[0].name : null;
          pushUnique(servers.entrypoints, {
            name,
            framework: 'node-http',
            kind: 'server',
            target: targetName,
            location,
          }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
          const handlerNode =
            t.isFunctionExpression(init.arguments[0]) || t.isArrowFunctionExpression(init.arguments[0])
              ? init.arguments[0]
              : (targetName ? functionDefinitions.get(targetName) ?? null : null);
          if (handlerNode) {
            nodeHttpHandlers.push({
              container: name,
              handlerName: targetName,
              handlerNode,
            });
          }
        } else if (callee === 'module.createRequire') {
          pushUnique(moduleLoading, { api: callee, location }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
        } else if (websocketContainer) {
          const { name: _ignoredName, ...restContainer } = websocketContainer;
          websocketContainers.set(name, restContainer);
        } else if (graphqlMiddleware) {
          const { name: _ignoredName, ...restMiddleware } = graphqlMiddleware;
          graphqlMiddlewareContainers.set(name, restMiddleware);
        } else if (graphqlKind && graphqlKind !== 'graphql-execute' && graphqlKind !== 'graphql-client' && graphqlKind !== 'graphql-mercurius') {
          graphqlMiddlewareContainers.set(name, {
            kind: graphqlKind,
            target: extractGraphqlTarget(init.arguments, graphqlKind, constantMap, functionDefinitions),
          });
        } else {
          const routeBuilder = resolveRouteBuilder(init, routeContainers, routeBuilderContainers, constantMap);
          if (routeBuilder) {
            routeBuilderContainers.set(name, routeBuilder);
          } else {
            const clientFactory = classifyHttpClientFactory(callee);
            if (clientFactory) {
              httpClientContainers.set(name, {
                client: clientFactory,
                target: extractBaseTarget(init.arguments[0], constantMap),
              });
            } else {
              const websocketConstructor = classifyWebSocketConstructor(callee);
              if (websocketConstructor) {
                websocketContainers.set(name, {
                  ...websocketConstructor,
                  target: extractWebSocketTarget(websocketConstructor, init.arguments, constantMap),
                });
              }
            }
          }
        }
      } else if (t.isNewExpression(init)) {
        const callee = expandBindingName(memberPath(init.callee), bindings);
        if (callee === 'koa' || callee === 'Koa') {
          routeContainers.set(name, 'koa');
          servers.frameworks.add('koa');
          pushUnique(servers.entrypoints, { name, framework: 'koa', kind: 'app', location }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
        } else if (callee === '@koa/router' || callee === 'koa-router') {
          routeContainers.set(name, 'koa-router');
          servers.frameworks.add('koa-router');
          pushUnique(servers.entrypoints, { name, framework: 'koa-router', kind: 'router', location }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
        } else if (callee === '@hapi/hapi.Server') {
          routeContainers.set(name, 'hapi');
          servers.frameworks.add('hapi');
          pushUnique(servers.entrypoints, { name, framework: 'hapi', kind: 'app', location }, (item) => `server:${item.framework}:${item.name}:${item.kind}`);
        } else if (callee === 'graphql-request.GraphQLClient') {
          const target = getResolvedString(init.arguments[0], constantMap);
          graphqlClientContainers.set(name, { client: 'graphql-request', target });
          pushGraphqlRecord(graphql, {
            kind: 'client',
            api: callee,
            target,
            location,
          });
        } else if (classifyGraphQLCall(callee) === 'apollo-server') {
          graphqlServerContainers.set(name, { kind: 'apollo-server' });
        } else if (t.isIdentifier(init.callee) && classDefinitions.has(init.callee.name)) {
          classInstances.set(name, {
            className: init.callee.name,
            thisBindings: buildClassInstanceBindings(classDefinitions.get(init.callee.name), init.arguments),
          });
        } else {
          const websocketConstructor = classifyWebSocketConstructor(callee);
          if (websocketConstructor) {
            websocketContainers.set(name, {
              ...websocketConstructor,
              target: extractWebSocketTarget(websocketConstructor, init.arguments, constantMap),
            });
          }
        }
      }
    },
    ImportDeclaration(path) {
      registerModule(path.node.source.value, 'import', literalLocation(path.node));
    },
    ImportExpression(path) {
      if (t.isStringLiteral(path.node.source)) {
        registerModule(path.node.source.value, 'dynamic-import', literalLocation(path.node));
      } else {
        dynamicImports.push({
          kind: 'dynamic-import',
          source: '[Expression]',
          location: literalLocation(path.node),
        });
      }
    },
    CallExpression(path) {
      const callee = expandBindingName(memberPath(path.node.callee), bindings);
      const rootName = getRootIdentifierName(path.node.callee);
      const propertyName = t.isMemberExpression(path.node.callee) || t.isOptionalMemberExpression(path.node.callee)
        ? (t.isIdentifier(path.node.callee.property) ? path.node.callee.property.name : memberPath(path.node.callee.property))
        : null;
      const location = literalLocation(path.node);

      if (t.isIdentifier(path.node.callee, { name: 'require' })) {
        const source = path.node.arguments[0];
        if (t.isStringLiteral(source)) {
          registerModule(source.value, 'require', literalLocation(path.node));
        } else {
          dynamicImports.push({
            kind: 'require',
            source: '[Expression]',
            location,
          });
        }
      }

      if (callee) {
        if (callee.startsWith('fs.') || callee.startsWith('fs/promises.') || callee.startsWith('node:fs.') || callee.startsWith('node:fs/promises.')) {
          filesystem.push({ api: callee, location: literalLocation(path.node) });
          if (/write|append|mkdir|rm|unlink|rename|copy/i.test(callee)) {
            persistence.push({ api: callee, location: literalLocation(path.node) });
          }
        }

        if (/^(?:http|https|net|tls|dns)\./.test(callee) || /^(?:node:)?(?:http|https|net|tls|dns)\./.test(callee)) {
          network.push({ api: callee, location });
        }

        if (/^(?:child_process|node:child_process)\./.test(callee)) {
          subprocess.push({ api: callee, location });
        }

        if (callee === 'eval' || callee === 'Function' || /^(?:vm|node:vm)\./.test(callee)) {
          dynamicCode.push({ api: callee, location });
        }

        if (/^(?:crypto|node:crypto)\./.test(callee) || /^CryptoJS\./.test(callee)) {
          crypto.push({ api: callee, location });
        }

        if (callee === 'process.dlopen' || callee === 'bindings' || callee === 'node-gyp-build') {
          nativeAddons.push({ api: callee, location });
        }

        if (callee.startsWith('WebAssembly.')) {
          webassembly.push({ api: callee, location });
        }

        if (/^(?:module|node:module)\.(?:createRequire|register|registerHooks|syncBuiltinESMExports)$/.test(callee)) {
          pushUnique(moduleLoading, { api: callee, location }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
        }

        if (/^(?:worker_threads|node:worker_threads)\.(?:parentPort|workerData|threadId|isMainThread|MessageChannel|BroadcastChannel)$/.test(callee)) {
          pushUnique(workers, { api: callee, location }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
        }

        if (/^(?:cluster|node:cluster)\.(?:fork|setupPrimary|setupMaster|isPrimary|isWorker|worker)$/.test(callee)) {
          pushUnique(cluster, { api: callee, location }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
        }

        const httpClient = classifyHttpClientCall(callee);
        if (httpClient) {
          pushUnique(httpClients, {
            api: callee,
            client: httpClient.client,
            transport: httpClient.transport,
            target: extractRequestTarget(path.node.arguments, constantMap),
            location,
          }, (item) => `${item.api}:${item.target}:${item.location.line}:${item.location.column}`);
        }

        const graphqlKind = classifyGraphQLCall(callee);
        if (graphqlKind) {
          pushGraphqlRecord(graphql, {
            kind: graphqlKind,
            api: callee,
            target: extractGraphqlTarget(path.node.arguments, graphqlKind, constantMap, functionDefinitions),
            location,
          });
        }
      }

      if (rootName && httpClientContainers.has(rootName) && propertyName) {
        const container = httpClientContainers.get(rootName);
        const methodName = String(propertyName);
        if (HTTP_CLIENT_INSTANCE_METHODS.has(methodName)) {
          const nextTarget = extractRequestTarget(path.node.arguments, constantMap);
          pushUnique(httpClients, {
            api: `${container.client}.${methodName}`,
            client: container.client,
            transport: methodName,
            target: resolveAbsoluteTarget(container.target, nextTarget),
            location,
          }, (item) => `${item.api}:${item.target}:${item.location.line}:${item.location.column}`);
        }
      }

      if (rootName && graphqlClientContainers.has(rootName) && propertyName) {
        const container = graphqlClientContainers.get(rootName);
        const methodName = String(propertyName);
        if (GRAPHQL_INSTANCE_METHODS.has(methodName)) {
          pushGraphqlRecord(graphql, {
            kind: 'graphql-client-call',
            api: `${container.client}.${methodName}`,
            target: container.target,
            location,
          });
        }
      }

      if (rootName && graphqlServerContainers.has(rootName) && propertyName === 'applyMiddleware') {
        const pathValue = getObjectString(path.node.arguments[0], ['path'], constantMap) ?? '/graphql';
        pushGraphqlRecord(graphql, {
          kind: 'apollo-apply-middleware',
          api: `${graphqlServerContainers.get(rootName).kind}.applyMiddleware`,
          target: pathValue,
          location,
        });
      }

      const websocketContainer = resolveWebSocketContainer(
        (t.isMemberExpression(path.node.callee) || t.isOptionalMemberExpression(path.node.callee)) ? path.node.callee.object : null,
        websocketContainers,
        constantMap,
        {
          functionDefinitions,
          classDefinitions,
          objectDefinitions,
          classInstances,
          bindings,
        },
      ) ?? (rootName && websocketContainers.has(rootName) ? { name: rootName, ...websocketContainers.get(rootName) } : null);
      const graphqlMiddleware = resolveGraphqlMiddlewareContainer(
        (t.isMemberExpression(path.node.callee) || t.isOptionalMemberExpression(path.node.callee)) ? path.node.callee.object : null,
        graphqlMiddlewareContainers,
        constantMap,
        {
          functionDefinitions,
          classDefinitions,
          objectDefinitions,
          classInstances,
          bindings,
        },
      ) ?? (rootName && graphqlMiddlewareContainers.has(rootName) ? { name: rootName, ...graphqlMiddlewareContainers.get(rootName) } : null);
      if (websocketContainer && propertyName) {
        const container = websocketContainer;
        const containerName = websocketContainer.name ?? rootName ?? '[inline]';
        const methodName = String(propertyName);
        const eventName = getResolvedString(path.node.arguments[0], constantMap);

        if (WEBSOCKET_LISTENER_METHODS.has(methodName) && eventName) {
          pushUnique(websockets, {
            kind: 'listener',
            api: `${container.transport}.${methodName}`,
            container: containerName,
            target: container.target,
            event: eventName,
            handler: inferCallableName(path.node.arguments[1]),
            namespace: container.namespace ?? null,
            room: container.room ?? null,
            location,
          }, (item) => `${item.kind}:${item.api}:${item.container}:${item.target}:${item.event}:${item.location.line}:${item.location.column}`);

          const nestedHandler = getFunctionLikeNode(path.node.arguments[1], functionDefinitions);
          if (nestedHandler && eventName === 'connection' && nestedHandler.params?.[0] && t.isIdentifier(nestedHandler.params[0])) {
            collectNestedWebSocketEvents(nestedHandler, {
              socketName: nestedHandler.params[0].name,
              transport: container.transport,
              target: container.target,
              container: containerName,
              namespace: container.namespace ?? null,
              functionDefinitions,
              constants: constantMap,
              collection: websockets,
            });
          }
        }

        if (WEBSOCKET_MIDDLEWARE_METHODS.has(methodName)) {
          pushUnique(websockets, {
            kind: 'middleware',
            api: `${container.transport}.${methodName}`,
            container: containerName,
            target: container.target,
            handler: inferCallableName(path.node.arguments[0]),
            namespace: container.namespace ?? null,
            room: container.room ?? null,
            location,
          }, (item) => `${item.kind}:${item.api}:${item.container}:${item.target}:${item.handler}:${item.location.line}:${item.location.column}`);
        }

        if (WEBSOCKET_ROOM_STATE_METHODS.has(methodName)) {
          pushUnique(websockets, {
            kind: methodName === 'join' ? 'room-join' : 'room-leave',
            api: `${container.transport}.${methodName}`,
            container: containerName,
            target: container.target,
            event: null,
            namespace: container.namespace ?? null,
            room: getResolvedString(path.node.arguments[0], constantMap),
            location,
          }, (item) => `${item.kind}:${item.api}:${item.container}:${item.target}:${item.room}:${item.location.line}:${item.location.column}`);
        }

        if (WEBSOCKET_EMIT_METHODS.has(methodName)) {
          pushUnique(websockets, {
            kind: methodName === 'emit' ? 'emit' : 'send',
            api: `${container.transport}.${methodName}`,
            container: containerName,
            target: container.target,
            event: methodName === 'emit' ? eventName : null,
            namespace: container.namespace ?? null,
            room: container.room ?? null,
            location,
          }, (item) => `${item.kind}:${item.api}:${item.container}:${item.target}:${item.event}:${item.location.line}:${item.location.column}`);
        }
      }

      if (rootName && routeContainers.has(rootName) && propertyName) {
        const framework = routeContainers.get(rootName);
        const normalizedMethod = String(propertyName).toLowerCase();
        if (framework === 'koa-router' && normalizedMethod === 'prefix') {
          const prefixValue = getResolvedString(path.node.arguments[0], constantMap);
          if (prefixValue) {
            routePrefixes.set(rootName, prefixValue);
          }
        } else if (framework === 'fastify' && normalizedMethod === 'register') {
          const pluginNode = path.node.arguments[0];
          const pluginCallee = expandBindingName(memberPath(pluginNode), bindings);
          const pluginKind = classifyGraphQLCall(pluginCallee);
          if (pluginKind === 'graphql-mercurius') {
            const graphPath = getObjectString(path.node.arguments[1], ['path'], constantMap) ?? '/graphql';
            pushGraphqlRecord(graphql, {
              kind: 'fastify-register',
              api: 'fastify.register',
              target: graphPath,
              location,
            });
          }
        } else if (HTTP_METHODS.has(normalizedMethod) || normalizedMethod === 'use') {
          const routePath = getResolvedString(path.node.arguments[0], constantMap);
          const handlerNode = routePath !== null ? path.node.arguments[1] : path.node.arguments[0];
          const routeRecord = {
            framework,
            container: rootName,
            method: normalizedMethod === 'use' ? 'USE' : normalizedMethod.toUpperCase(),
            path: routePath,
            handler: inferCallableName(handlerNode),
            location,
          };
          pushRouteRecord(rawRouteRecords, routeRecord);

          if (
            framework === 'express'
            && normalizedMethod === 'use'
            && t.isIdentifier(path.node.arguments[1])
            && routeContainers.has(path.node.arguments[1].name)
          ) {
            const child = path.node.arguments[1].name;
            const mounts = routeMounts.get(child) ?? [];
            mounts.push({
              parent: rootName,
              parentFramework: framework,
              prefix: routePath,
              location,
            });
            routeMounts.set(child, mounts);
          }

          if (
            routePath?.toLowerCase().includes('graphql')
            || (t.isIdentifier(handlerNode) && graphqlMiddlewareContainers.has(handlerNode.name))
            || !!graphqlMiddleware
            || (handlerNode && classifyGraphQLCall(expandBindingName(memberPath(handlerNode.callee ?? handlerNode), bindings)))
          ) {
            const middlewareTarget = t.isIdentifier(handlerNode)
              ? graphqlMiddlewareContainers.get(handlerNode.name)?.target ?? null
              : graphqlMiddleware?.target ?? null;
            pushGraphqlRecord(graphql, {
              kind: 'route',
              api: `${framework}.${routeRecord.method.toLowerCase()}`,
              target: routePath ?? middlewareTarget,
              location,
            });
          }
        } else if (framework === 'fastify' && normalizedMethod === 'route' && t.isObjectExpression(path.node.arguments[0])) {
          const routePath = getObjectString(path.node.arguments[0], ['url', 'path'], constantMap);
          const methods = getObjectArray(path.node.arguments[0], ['method'], constantMap);
          const handlerNode = findObjectProperty(path.node.arguments[0], ['handler']);
          for (const method of methods.length > 0 ? methods : ['ROUTE']) {
            pushRouteRecord(servers.routes, {
              framework,
              container: rootName,
              method,
              path: routePath,
              handler: inferCallableName(handlerNode),
              location,
            });
          }
        } else if (framework === 'hapi' && normalizedMethod === 'route' && path.node.arguments[0]) {
          const routes = collectHapiRoutes(path.node.arguments[0], {
            framework,
            container: rootName,
            location,
            constants: constantMap,
          });
          for (const route of routes) {
            pushRouteRecord(servers.routes, route);
            if (route.path?.toLowerCase().includes('graphql')) {
              pushGraphqlRecord(graphql, {
                kind: 'route',
                api: 'hapi.route',
                target: route.path,
                location: route.location,
              });
            }
          }
        }
      }

      if (propertyName && HTTP_METHODS.has(String(propertyName).toLowerCase())) {
        const routeBuilder = routeBuilderContainers.get(rootName);
        if (routeBuilder) {
          pushRouteRecord(rawRouteRecords, {
            framework: routeBuilder.framework,
            container: routeBuilder.container,
            method: String(propertyName).toUpperCase(),
            path: routeBuilder.path,
            handler: inferCallableName(path.node.arguments[0]),
            location,
          });
        } else if (t.isMemberExpression(path.node.callee) || t.isOptionalMemberExpression(path.node.callee)) {
          const directBuilder = resolveRouteBuilder(path.node.callee.object, routeContainers, routeBuilderContainers, constantMap);
          if (directBuilder) {
            pushRouteRecord(rawRouteRecords, {
              framework: directBuilder.framework,
              container: directBuilder.container,
              method: String(propertyName).toUpperCase(),
              path: directBuilder.path,
              handler: inferCallableName(path.node.arguments[0]),
              location,
            });
          }
        }
      }
    },
    NewExpression(path) {
      const callee = expandBindingName(memberPath(path.node.callee), bindings);
      const location = literalLocation(path.node);

      if (/^(?:worker_threads|node:worker_threads)\.Worker$/.test(callee ?? '')) {
        pushUnique(workers, {
          api: callee,
          source: getResolvedString(path.node.arguments[0], constantMap),
          location,
        }, (item) => `${item.api}:${item.source}:${item.location.line}:${item.location.column}`);
      }

      if (
        callee === 'WebSocket'
        || callee === 'ws'
        || callee === 'ws.WebSocket'
        || callee === 'socket.io-client.io'
        || callee === 'socket.io-client.Manager'
      ) {
        pushUnique(websockets, {
          kind: 'client',
          api: callee,
          target: getResolvedString(path.node.arguments[0], constantMap),
          location,
        }, (item) => `${item.kind}:${item.api}:${item.target}:${item.location.line}:${item.location.column}`);
      }

      if (callee === 'ws.WebSocketServer' || callee === 'ws.Server' || callee === 'WebSocket.Server' || callee === 'socket.io.Server') {
        pushUnique(websockets, {
          kind: 'server',
          api: callee,
          target: extractWebSocketTarget(classifyWebSocketConstructor(callee), path.node.arguments, constantMap),
          location,
        }, (item) => `${item.kind}:${item.api}:${item.target}:${item.location.line}:${item.location.column}`);
      }

      const graphqlKind = classifyGraphQLCall(callee);
      if (graphqlKind) {
        pushGraphqlRecord(graphql, {
          kind: graphqlKind,
          api: callee,
          target: getResolvedString(path.node.arguments[0], constantMap),
          location,
        });
      }
    },
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      const bound = bindings.get(path.node.name);
      if (!bound) return;
      const location = literalLocation(path.node);
      if (/^(?:worker_threads|node:worker_threads)\./.test(bound)) {
        pushUnique(workers, { api: bound, location }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
      }
      if (/^(?:cluster|node:cluster)\./.test(bound)) {
        pushUnique(cluster, { api: bound, location }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
      }
    },
    MemberExpression(path) {
      const name = expandBindingName(memberPath(path.node), bindings);
      if (!name) return;

      if (name.startsWith('process.env.')) {
        const key = name.slice('process.env.'.length);
        processSignals.envKeys.push({
          key,
          location: literalLocation(path.node),
        });
      } else if (name === 'process.argv' || name.startsWith('process.argv.')) {
        processSignals.argvAccesses.push({ api: name, location: literalLocation(path.node) });
      } else if (name === 'process.cwd') {
        processSignals.cwdAccesses.push({ api: name, location: literalLocation(path.node) });
      } else if (name === 'process.exit') {
        processSignals.exitCalls.push({ api: name, location: literalLocation(path.node) });
      } else if (name === 'Buffer' || name.startsWith('Buffer.')) {
        if (name === 'Buffer' || name.startsWith('Buffer.from') || name.startsWith('Buffer.alloc')) {
          persistence.push({ api: name, location: literalLocation(path.node) });
        }
      }

      if (
        name === 'require.extensions'
        || name === 'module.children'
        || name === 'module.parent'
        || name === 'module.paths'
      ) {
        pushUnique(moduleLoading, { api: name, location: literalLocation(path.node) }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
      }

      if (/^(?:worker_threads|node:worker_threads)\./.test(name)) {
        pushUnique(workers, { api: name, location: literalLocation(path.node) }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
      }

      if (/^(?:cluster|node:cluster)\./.test(name)) {
        pushUnique(cluster, { api: name, location: literalLocation(path.node) }, (item) => `${item.api}:${item.location.line}:${item.location.column}`);
      }

      if (name.includes('.node') || name.includes('ffi-napi') || name.includes('node-gyp-build') || name.includes('bindings')) {
        nativeAddons.push({ api: name, location: literalLocation(path.node) });
      }
    },
  });

  traverse(parsed.ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return;
      const rootName = getRootIdentifierName(callee);
      const propertyName = t.isIdentifier(callee.property) ? callee.property.name : memberPath(callee.property);
      if (!rootName || propertyName !== 'route' || routeContainers.get(rootName) !== 'hapi' || !path.node.arguments[0]) {
        return;
      }

      const location = literalLocation(path.node);
      const routes = collectHapiRoutes(path.node.arguments[0], {
        framework: 'hapi',
        container: rootName,
        location,
        constants: constantMap,
      });
      for (const route of routes) {
        pushRouteRecord(rawRouteRecords, route);
        if (route.path?.toLowerCase().includes('graphql')) {
          pushGraphqlRecord(graphql, {
            kind: 'route',
            api: 'hapi.route',
            target: route.path,
            location: route.location,
          });
        }
      }
    },
  });

  for (const handler of nodeHttpHandlers) {
    const routes = collectNodeHttpRoutes(handler.handlerNode, {
      container: handler.container,
      constants: constantMap,
      functionDefinitions,
      routeTables,
      functionName: handler.handlerName,
    });
    for (const route of routes) {
      pushRouteRecord(rawRouteRecords, route);
    }
  }

  const deobfuscation = deobfuscateNodeLiterals(code);
  const suspiciousSinks = [];
  for (const item of dynamicCode) pushUnique(suspiciousSinks, { category: 'dynamic-code', ...item });
  for (const item of subprocess) pushUnique(suspiciousSinks, { category: 'subprocess', ...item });
  for (const item of nativeAddons) pushUnique(suspiciousSinks, { category: 'native-addon', ...item });
  for (const item of webassembly) pushUnique(suspiciousSinks, { category: 'webassembly', ...item });

  const riskScore =
    suspiciousSinks.length * 4 +
    network.length * 1 +
    filesystem.length * 1 +
    processSignals.envKeys.length * 1 +
    moduleLoading.length * 0.5 +
    workers.length * 0.5 +
    deobfuscation.data.decodedStrings.length * 0.1;
  const riskLevel =
    subprocess.length > 0 || dynamicCode.length > 0 || nativeAddons.length > 0
      ? 'high'
      : riskScore >= 7
        ? 'medium'
        : 'low';

  const moduleFormat = imports.some((entry) => entry.kind === 'import')
    ? imports.some((entry) => entry.kind === 'require') ? 'mixed' : 'esm'
    : imports.some((entry) => entry.kind === 'require') || code.includes('module.exports') || code.includes('exports.')
      ? 'cjs'
      : 'unknown';
  const resolvedRoutes = collectMountedRouteRecords(rawRouteRecords, routeMounts, routePrefixes);

  return {
    success: true,
    data: {
      meta: {
        moduleFormat,
        executableLikely: cli.shebang || processSignals.argvAccesses.length > 0 || cli.frameworks.length > 0,
        shebang: cli.shebang,
      },
      modules: {
        imports,
        builtin: [...builtinModulesUsed].sort(),
        external: [...externalModules].sort(),
        relative: [...relativeModules].sort(),
        dynamic: dynamicImports,
      },
      runtime: {
        process: {
          envKeys: processSignals.envKeys,
          argvAccesses: processSignals.argvAccesses,
          cwdAccesses: processSignals.cwdAccesses,
          exitCalls: processSignals.exitCalls,
        },
        filesystem,
        network,
        httpClients,
        servers: {
          frameworks: [...servers.frameworks].sort(),
          entrypoints: servers.entrypoints,
          routes: resolvedRoutes,
        },
        subprocess,
        dynamicCode,
        crypto,
        nativeAddons,
        webassembly,
        workers,
        cluster,
        moduleLoading,
        websockets,
        graphql,
        persistence,
      },
      cli: {
        frameworks: [...new Set(cli.frameworks)].sort(),
      },
      deobfuscation: deobfuscation.data,
      risks: {
        suspiciousSinks,
        score: Number(riskScore.toFixed(1)),
        level: riskLevel,
      },
    },
  };
}
