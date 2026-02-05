// Oxc-only adapter for dependency scanning (CommonJS)
// Hard dependency on 'oxc-parser'. If not installed, this module will throw at runtime.

const oxc = require('oxc-parser');

/**
 * Analyze module dependencies using oxc-parser
 *
 * Uses moduleLexerSync for ES6 imports/exports and regex patterns for require() and eval()
 *
 * @param {string} code - The JavaScript/TypeScript code to analyze
 * @returns {{
 *   static: string[],
 *   dynamicLiteral: string[],
 *   dynamicNonLiteral: number,
 *   evalCount: number,
 *   details: Array<{moduleId: string, kind: string, start?: number, end?: number}>
 * }}
 */
function analyzeModuleIDs(code) {
  if (!oxc || !oxc.moduleLexerSync) {
    throw new Error("oxc-parser not available. Please install it with 'npm i -D oxc-parser'.");
  }

  const foundStatic = new Set();
  const foundDyn = new Set();
  let dynNonLiteral = 0;
  let evalCount = 0;
  const details = [];

  // Use moduleLexerSync for ES6 imports and exports
  try {
    const lexerResult = oxc.moduleLexerSync(code);

    // Process static imports
    if (lexerResult.imports) {
      for (const imp of lexerResult.imports) {
        if (imp.n) {
          // imp.n is the module specifier
          foundStatic.add(imp.n);
          details.push({
            moduleId: imp.n,
            kind: imp.d >= 0 ? 'dynamic' : 'import',
            start: imp.s,
            end: imp.e,
          });

          // Check if it's a dynamic import (d >= 0 means dynamic)
          if (imp.d >= 0) {
            foundDyn.add(imp.n);
          }
        } else if (imp.d >= 0) {
          // Dynamic import with non-literal specifier
          dynNonLiteral++;
        }
      }
    }

    // Process static exports (re-exports)
    if (lexerResult.exports) {
      for (const exp of lexerResult.exports) {
        if (exp.n) {
          foundStatic.add(exp.n);
          details.push({
            moduleId: exp.n,
            kind: 'export',
            start: exp.s,
            end: exp.e,
          });
        }
      }
    }
  } catch (err) {
    // If lexer fails, continue with regex-based detection
    console.warn('[oxc-adapter] moduleLexerSync failed:', err.message);
  }

  // Helper: Check if a position is inside a comment or string literal
  function isInCommentOrString(code, pos) {
    const beforePos = code.substring(0, pos);

    // Check if in single-line comment
    const lastNewline = beforePos.lastIndexOf('\n');
    const linePart = beforePos.substring(lastNewline + 1);
    if (linePart.indexOf('//') !== -1) {
      return true;
    }

    // Check if in multi-line comment
    const openComment = beforePos.lastIndexOf('/*');
    const closeComment = beforePos.lastIndexOf('*/');
    if (openComment > closeComment) {
      return true;
    }

    // Check if in string literal (simplified - count quotes before position)
    // This is not perfect but works for most cases
    const doubleQuotes = (beforePos.match(/(?<!\\)"/g) || []).length;
    const singleQuotes = (beforePos.match(/(?<!\\)'/g) || []).length;
    const backticks = (beforePos.match(/(?<!\\)`/g) || []).length;

    // If odd number of quotes, we're inside a string
    return doubleQuotes % 2 === 1 || singleQuotes % 2 === 1 || backticks % 2 === 1;
  }

  // Use regex to find require() calls
  // Matches: require('module'), require("module"), require(`module`)
  const requirePattern = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  let match;
  while ((match = requirePattern.exec(code)) !== null) {
    // Skip if this match is inside a comment or string
    if (!isInCommentOrString(code, match.index)) {
      const moduleName = match[2];
      foundStatic.add(moduleName);
      details.push({
        moduleId: moduleName,
        kind: 'require',
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // Count eval() calls (skip those in comments or strings)
  const evalPattern = /\beval\s*\(/g;
  let evalMatch;
  while ((evalMatch = evalPattern.exec(code)) !== null) {
    if (!isInCommentOrString(code, evalMatch.index)) {
      evalCount++;
    }
  }

  return {
    static: Array.from(foundStatic),
    dynamicLiteral: Array.from(foundDyn),
    dynamicNonLiteral: dynNonLiteral,
    evalCount,
    details,
  };
}

/**
 * Analyze JSX props and infer types for JSI optimization
 *
 * @param {string} code - The JavaScript/TypeScript/JSX code to analyze
 * @returns {{
 *   propHints: Array<{
 *     location: string,
 *     element: string,
 *     props: Record<string, string>
 *   }>,
 *   stats: {
 *     totalElements: number,
 *     jsiSafeProps: number,
 *     functionsProps: number,
 *     unknownProps: number
 *   }
 * }}
 */
function analyzeJSXProps(code) {
  if (!oxc || !oxc.parseSync) {
    throw new Error("oxc-parser not available. Please install it with 'npm i -D oxc-parser'.");
  }

  const propHints = [];
  const stats = {
    totalElements: 0,
    jsiSafeProps: 0,
    functionProps: 0,
    unknownProps: 0,
  };

  try {
    // Parse code to AST
    // Note: oxc.parseSync signature is (code, options), not (filename, code, options)
    const result = oxc.parseSync(code, {
      sourceFilename: 'anonymous.tsx',
    });

    if (result.errors && result.errors.length > 0) {
      console.warn('[oxc-adapter] Parse errors:', result.errors.length);
      // Continue with partial AST
    }

    // oxc-parser returns program as JSON string, need to parse it
    const ast = typeof result.program === 'string' ? JSON.parse(result.program) : result.program;

    // Traverse AST to find JSX elements
    traverseAST(ast, (node) => {
      if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
        stats.totalElements++;

        if (node.type === 'JSXElement') {
          const elementName = getJSXElementName(node.openingElement);
          const props = {};

          // Analyze each prop
          for (const attr of node.openingElement.attributes || []) {
            if (attr.type === 'JSXAttribute') {
              // attr.name can be JSXIdentifier or Identifier
              const propName =
                attr.name && (attr.name.type === 'JSXIdentifier' || attr.name.type === 'Identifier')
                  ? attr.name.name
                  : null;
              if (!propName) continue;

              const propType = inferPropType(attr.value);
              props[propName] = propType;

              // Update stats
              if (propType === 'function') stats.functionProps++;
              else if (
                propType.startsWith('jsi-safe') ||
                propType === 'string' ||
                propType === 'number' ||
                propType === 'boolean' ||
                propType === 'true'
              )
                stats.jsiSafeProps++;
              else if (propType === 'unknown') stats.unknownProps++;
            }
          }

          // Store hint with location (use start:end instead of span)
          const location =
            node.start !== undefined && node.end !== undefined
              ? `${node.start}:${node.end}`
              : 'unknown';
          propHints.push({
            location,
            element: elementName,
            props,
          });
        }
      }
    });
  } catch (err) {
    console.error('[oxc-adapter] analyzeJSXProps failed:', err.message);
    // Return empty result on error
  }

  return { propHints, stats };
}

/**
 * Get JSX element name from opening element
 */
function getJSXElementName(openingElement) {
  if (!openingElement || !openingElement.name) return 'Unknown';

  const name = openingElement.name;

  // Handle both JSXIdentifier and Identifier types
  if (name.type === 'JSXIdentifier' || name.type === 'Identifier') {
    return name.name;
  } else if (name.type === 'JSXMemberExpression' || name.type === 'StaticMemberExpression') {
    // e.g., React.Component
    return getJSXMemberExpressionName(name);
  } else if (name.type === 'JSXNamespacedName') {
    // e.g., svg:path
    return `${name.namespace.name}:${name.name.name}`;
  }

  return 'Unknown';
}

function getJSXMemberExpressionName(expr) {
  const parts = [];
  let current = expr;

  while (current) {
    if (current.type === 'JSXMemberExpression') {
      if (current.property?.name) {
        parts.unshift(current.property.name);
      }
      current = current.object;
    } else if (current.type === 'JSXIdentifier') {
      parts.unshift(current.name);
      break;
    } else {
      break;
    }
  }

  return parts.join('.');
}

/**
 * Infer prop type from JSX attribute value
 */
function inferPropType(value) {
  if (!value) return 'true'; // Boolean shorthand: <Component prop />

  // String literal
  if (value.type === 'StringLiteral') {
    return 'string';
  }

  // JSX expression container
  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;

    // Null/undefined
    if (expr.type === 'NullLiteral') return 'null';
    if (expr.type === 'Identifier' && expr.name === 'undefined') return 'undefined';

    // Number literal
    if (expr.type === 'NumericLiteral') return 'number';

    // Boolean literal
    if (expr.type === 'BooleanLiteral') return 'boolean';

    // String literal (in expression)
    if (expr.type === 'StringLiteral') return 'string';

    // Function (arrow function or function expression)
    if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
      return 'function';
    }

    // Object literal
    if (expr.type === 'ObjectExpression') {
      return analyzeObjectExpression(expr);
    }

    // Array literal
    if (expr.type === 'ArrayExpression') {
      return analyzeArrayExpression(expr);
    }

    // Variable reference or other expressions
    return 'unknown';
  }

  // JSX element as prop value
  if (value.type === 'JSXElement' || value.type === 'JSXFragment') {
    return 'jsx-element';
  }

  return 'unknown';
}

/**
 * Analyze object literal to determine if it's JSI-safe
 */
function analyzeObjectExpression(node) {
  if (!node.properties || node.properties.length === 0) {
    return 'jsi-safe-object'; // Empty object is safe
  }

  // Check if all properties are JSI-safe
  for (const prop of node.properties) {
    // Spread operator or computed keys - not JSI-safe
    if (prop.type !== 'ObjectProperty') {
      return 'object';
    }

    // Check if key is simple
    if (prop.computed || (prop.key.type !== 'Identifier' && prop.key.type !== 'StringLiteral')) {
      return 'object';
    }

    // Recursively check value type
    const valueType = inferPropTypeFromExpression(prop.value);
    if (!isJSISafeType(valueType)) {
      return 'object';
    }
  }

  return 'jsi-safe-object';
}

/**
 * Analyze array literal to determine if it's JSI-safe
 */
function analyzeArrayExpression(node) {
  if (!node.elements || node.elements.length === 0) {
    return 'jsi-safe-array'; // Empty array is safe
  }

  // Check if all elements are JSI-safe
  for (const elem of node.elements) {
    if (!elem) continue; // Sparse array element

    // Spread element - not JSI-safe
    if (elem.type === 'SpreadElement') {
      return 'array';
    }

    const elemType = inferPropTypeFromExpression(elem);
    if (!isJSISafeType(elemType)) {
      return 'array';
    }
  }

  return 'jsi-safe-array';
}

/**
 * Infer type from any expression node
 */
function inferPropTypeFromExpression(expr) {
  if (!expr) return 'unknown';

  if (expr.type === 'NullLiteral') return 'null';
  if (expr.type === 'NumericLiteral') return 'number';
  if (expr.type === 'BooleanLiteral') return 'boolean';
  if (expr.type === 'StringLiteral') return 'string';
  if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
    return 'function';
  }
  if (expr.type === 'ObjectExpression') return analyzeObjectExpression(expr);
  if (expr.type === 'ArrayExpression') return analyzeArrayExpression(expr);

  return 'unknown';
}

/**
 * Check if a type is JSI-safe (primitive types and jsi-safe composites)
 */
function isJSISafeType(type) {
  return [
    'string',
    'number',
    'boolean',
    'null',
    'undefined',
    'true',
    'jsi-safe-object',
    'jsi-safe-array',
  ].includes(type);
}

/**
 * Simple AST traversal helper
 */
function traverseAST(node, visitor) {
  if (!node || typeof node !== 'object') return;

  // Visit current node
  visitor(node);

  // Traverse children
  for (const key in node) {
    if (key === 'span' || key === 'loc' || key === 'range') continue; // Skip metadata

    const child = node[key];

    if (Array.isArray(child)) {
      for (const item of child) {
        traverseAST(item, visitor);
      }
    } else if (child && typeof child === 'object') {
      traverseAST(child, visitor);
    }
  }
}

module.exports = { analyzeModuleIDs, analyzeJSXProps };
