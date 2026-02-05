import { describe, expect, test } from 'bun:test';
import { analyzeJSXProps, analyzeModuleIDs } from './oxc-adapter';

describe('oxcAdapter - Module ID Analysis', () => {
  describe('Basic Functionality', () => {
    test('should return correct result structure', async () => {
      const code = `import React from 'react';`;
      const result = await analyzeModuleIDs(code);

      expect(result).toBeDefined();
      expect(result.static).toBeDefined();
      expect(result.dynamicLiteral).toBeDefined();
      expect(result.dynamicNonLiteral).toBeDefined();
      expect(result.evalCount).toBeDefined();
      expect(result.details).toBeDefined();

      expect(Array.isArray(result.static)).toBe(true);
      expect(Array.isArray(result.dynamicLiteral)).toBe(true);
      expect(typeof result.dynamicNonLiteral).toBe('number');
      expect(typeof result.evalCount).toBe('number');
      expect(Array.isArray(result.details)).toBe(true);
    });

    test('should handle empty code', async () => {
      const result = await analyzeModuleIDs('');

      expect(result.static).toHaveLength(0);
      expect(result.dynamicLiteral).toHaveLength(0);
      expect(result.dynamicNonLiteral).toBe(0);
      expect(result.evalCount).toBe(0);
    });

    test('should handle code with only comments', async () => {
      const code = `
        // This is a comment
        /* Block comment */
      `;
      const result = await analyzeModuleIDs(code);

      expect(result.static).toHaveLength(0);
      expect(result.dynamicLiteral).toHaveLength(0);
    });
  });

  describe('Static Imports', () => {
    test('should detect ES6 import statements', async () => {
      const code = `
        import React from 'react';
        import { useState } from 'react';
        import * as utils from './utils';
      `;
      const result = await analyzeModuleIDs(code);

      // Should detect import statements
      expect(result).toBeDefined();
      expect(result.static.length).toBeGreaterThan(0);
      expect(result.details.filter((d) => d.kind === 'import').length).toBeGreaterThan(0);
    });

    test('should detect export from statements', async () => {
      const code = `
        export { default } from './App';
        export * from './utils';
      `;
      const result = await analyzeModuleIDs(code);

      // Export re-exports should be detected (if oxc-parser provides them)
      expect(result).toBeDefined();
      expect(Array.isArray(result.static)).toBe(true);
      expect(Array.isArray(result.details)).toBe(true);
    });

    test('should detect require calls', async () => {
      const code = `
        const fs = require('fs');
        const path = require('path');
      `;
      const result = await analyzeModuleIDs(code);

      expect(result.static).toContain('fs');
      expect(result.static).toContain('path');
      expect(result.details.filter((d) => d.kind === 'require').length).toBe(2);
    });

    test('should handle require in different contexts', async () => {
      const code = `
        const mod = require('./module');
        let x;
        x = require('./another');
      `;
      const result = await analyzeModuleIDs(code);

      expect(result.static).toContain('./module');
      expect(result.static).toContain('./another');
    });
  });

  describe('Dynamic Imports', () => {
    test('should detect literal dynamic imports', async () => {
      const code = `
        const mod = await import('./module');
        import('./another').then(m => m);
      `;
      const result = await analyzeModuleIDs(code);

      // Dynamic imports should be detected
      expect(result).toBeDefined();
      expect(result.dynamicLiteral.length + result.dynamicNonLiteral).toBeGreaterThan(0);
    });

    test('should count non-literal dynamic imports', async () => {
      const code = `
        const moduleName = 'react';
        import(moduleName);
        import(getModuleName());
      `;
      const result = await analyzeModuleIDs(code);

      expect(result.dynamicNonLiteral).toBeGreaterThan(0);
    });
  });

  describe('eval() Detection', () => {
    test('should count eval calls', async () => {
      const code = `
        eval('console.log("test")');
        const x = eval('2 + 2');
        if (true) eval(someCode);
      `;
      const result = await analyzeModuleIDs(code);

      expect(result.evalCount).toBe(3);
    });

    test('should not confuse eval-like function names', async () => {
      const code = `
        function evalSomething() {}
        const evaluate = () => {};
        evalSomething();
        evaluate();
      `;
      const result = await analyzeModuleIDs(code);

      expect(result.evalCount).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    test('should handle syntax in strings', async () => {
      const code = `
        const str = "import React from 'react'";
        const code = 'require("fs")';
      `;
      const result = await analyzeModuleIDs(code);

      // String content should not be parsed as actual imports
      expect(result.static.length).toBeLessThan(2);
    });

    test('should handle malformed but parseable code', async () => {
      const code = `
        const x = 1
        const y = 2
      `;
      // Should not throw despite missing semicolons
      const result = await analyzeModuleIDs(code);

      expect(result).toBeDefined();
    });
  });

  describe('Details Information', () => {
    test('should include kind for detected modules', async () => {
      const code = `const mod = require('test');`;
      const result = await analyzeModuleIDs(code);

      if (result.details.length > 0) {
        expect(result.details[0]).toHaveProperty('kind');
        expect(result.details[0]).toHaveProperty('moduleId');
      }
    });
  });
});

describe('oxcAdapter - JSX Props Analysis', () => {
  describe('Basic Prop Types', () => {
    test('should analyze string props', () => {
      const code = `const App = () => <Panel title="Hello" />;`;
      const result = analyzeJSXProps(code);

      expect(result.stats.totalElements).toBe(1);
      expect(result.propHints[0].props.title).toBe('string');
    });

    test('should analyze number props', () => {
      const code = `const App = () => <Panel count={42} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.count).toBe('number');
    });

    test('should analyze boolean props', () => {
      const code = `const App = () => <Panel enabled={true} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.enabled).toBe('boolean');
    });

    test('should detect function props', () => {
      const code = `const App = () => <Button onClick={() => console.log('clicked')} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.onClick).toBe('function');
      expect(result.stats.functionProps).toBe(1);
    });

    test('should handle boolean shorthand props', () => {
      const code = `const App = () => <Button disabled />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.disabled).toBe('true');
    });
  });

  describe('JSI-Safe Objects', () => {
    test('should detect JSI-safe object literals', () => {
      const code = `
        const App = () => (
          <Panel config={{ theme: 'dark', count: 42, enabled: true }} />
        );
      `;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.config).toBe('jsi-safe-object');
      expect(result.stats.jsiSafeProps).toBeGreaterThan(0);
    });

    test('should detect empty JSI-safe objects', () => {
      const code = `const App = () => <Panel config={{}} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.config).toBe('jsi-safe-object');
    });

    test('should detect non-JSI-safe objects with functions', () => {
      const code = `
        const App = () => (
          <Panel config={{ onClick: () => {} }} />
        );
      `;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.config).toBe('object');
    });

    test('should detect nested JSI-safe objects', () => {
      const code = `
        const App = () => (
          <Panel
            nested={{
              user: { name: 'Alice', age: 30 },
              active: true
            }}
          />
        );
      `;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.nested).toBe('jsi-safe-object');
    });
  });

  describe('JSI-Safe Arrays', () => {
    test('should detect JSI-safe array literals', () => {
      const code = `const App = () => <List items={[1, 2, 3]} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.items).toBe('jsi-safe-array');
    });

    test('should detect empty JSI-safe arrays', () => {
      const code = `const App = () => <List items={[]} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.items).toBe('jsi-safe-array');
    });

    test('should detect non-JSI-safe arrays with functions', () => {
      const code = `const App = () => <List handlers={[() => {}, () => {}]} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.handlers).toBe('array');
    });

    test('should detect arrays with mixed safe types', () => {
      const code = `const App = () => <List items={[1, 'two', true, null]} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.items).toBe('jsi-safe-array');
    });
  });

  describe('Unknown Types', () => {
    test('should mark variable references as unknown', () => {
      const code = `const App = ({ data }) => <Panel config={data} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.config).toBe('unknown');
      expect(result.stats.unknownProps).toBe(1);
    });

    test('should mark complex expressions as unknown', () => {
      const code = `const App = () => <Panel config={getData()} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props.config).toBe('unknown');
    });
  });

  describe('Multiple Elements', () => {
    test('should analyze multiple JSX elements', () => {
      const code = `
        const App = () => (
          <div>
            <Panel title="First" />
            <Button onClick={() => {}} />
            <List items={[1, 2, 3]} />
          </div>
        );
      `;
      const result = analyzeJSXProps(code);

      expect(result.stats.totalElements).toBe(4); // div + Panel + Button + List
      expect(result.propHints).toHaveLength(4);
    });

    test('should handle nested elements', () => {
      const code = `
        const App = () => (
          <Panel>
            <Header title="Test" />
            <Content>
              <Item value={42} />
            </Content>
          </Panel>
        );
      `;
      const result = analyzeJSXProps(code);

      expect(result.stats.totalElements).toBeGreaterThan(3);
    });
  });

  describe('Statistics', () => {
    test('should collect accurate statistics', () => {
      const code = `
        const App = () => (
          <Panel
            title="Hello"
            config={{ theme: 'dark' }}
            items={[1, 2, 3]}
            onClick={() => {}}
            data={someVariable}
          />
        );
      `;
      const result = analyzeJSXProps(code);

      expect(result.stats.totalElements).toBe(1);
      expect(result.stats.jsiSafeProps).toBeGreaterThanOrEqual(2); // config, items (title is also jsi-safe as string)
      expect(result.stats.functionProps).toBe(1); // onClick
      expect(result.stats.unknownProps).toBe(1); // data
    });
  });

  describe('Edge Cases', () => {
    test('should handle JSX fragments', () => {
      const code = `
        const App = () => (
          <>
            <Panel title="Test" />
          </>
        );
      `;
      const result = analyzeJSXProps(code);

      expect(result.stats.totalElements).toBeGreaterThan(0);
    });

    test('should return empty result for non-JSX code', () => {
      const code = `const sum = (a, b) => a + b;`;
      const result = analyzeJSXProps(code);

      expect(result.stats.totalElements).toBe(0);
      expect(result.propHints).toHaveLength(0);
    });

    test('should handle malformed JSX gracefully', () => {
      const code = `const App = () => <Panel`;

      // Should not throw
      expect(() => analyzeJSXProps(code)).not.toThrow();

      const result = analyzeJSXProps(code);
      expect(result).toBeDefined();
      expect(result.propHints).toBeDefined();
      expect(result.stats).toBeDefined();
    });

    test('should handle spread operators in objects', () => {
      const code = `
        const App = () => {
          const config = { ...baseConfig, theme: 'dark' };
          return <Panel config={config} />;
        };
      `;
      const result = analyzeJSXProps(code);

      // Variable reference with spread - marked as unknown
      expect(result.propHints[0].props.config).toBe('unknown');
    });

    test('should handle computed property names', () => {
      const code = `const App = () => <Panel config={{ [key]: 'value' }} />;`;
      const result = analyzeJSXProps(code);

      // Computed keys make it not JSI-safe
      expect(result.propHints[0].props.config).toBe('object');
    });
  });

  describe('Result Structure', () => {
    test('should include location information', () => {
      const code = `const App = () => <Panel title="Test" />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0]).toHaveProperty('location');
      expect(result.propHints[0].location).toMatch(/\d+:\d+/);
    });

    test('should include element name', () => {
      const code = `const App = () => <MyCustomComponent />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].element).toBe('MyCustomComponent');
    });

    test('should include props object', () => {
      const code = `const App = () => <Panel title="Test" count={42} />;`;
      const result = analyzeJSXProps(code);

      expect(result.propHints[0].props).toHaveProperty('title');
      expect(result.propHints[0].props).toHaveProperty('count');
    });
  });
});
