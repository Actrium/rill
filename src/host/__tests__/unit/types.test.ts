/**
 * Types definition tests
 *
 * These tests verify correctness and completeness of public type definitions
 */

import { describe, expect, it } from 'bun:test';
import { HostMsg } from '../../types';
import type {
  AppendOperation,
  CallFunctionMessage,
  ConfigUpdateMessage,
  CreateOperation,
  DeleteOperation,
  DestroyMessage,
  HostEventMessage,
  InsertOperation,
  NodeInstance,
  OperationBatch,
  OperationType,
  RemoveOperation,
  ReorderOperation,
  SerializedFunction,
  SerializedProps,
  SerializedValue,
  StyleObject,
  StyleProp,
  TextOperation,
  UpdateOperation,
  VNode,
} from './types';

describe('Operation Types', () => {
  describe('OperationType', () => {
    it('should include all operation types', () => {
      const types: OperationType[] = [
        'CREATE',
        'UPDATE',
        'DELETE',
        'APPEND',
        'INSERT',
        'REMOVE',
        'REORDER',
        'TEXT',
      ];

      expect(types).toHaveLength(8);
    });
  });

  describe('CreateOperation', () => {
    it('should have correct structure', () => {
      const op: CreateOperation = {
        op: 'CREATE',
        id: 1,
        type: 'View',
        props: { style: { flex: 1 } },
      };

      expect(op.op).toBe('CREATE');
      expect(op.id).toBe(1);
      expect(op.type).toBe('View');
      expect(op.props).toBeDefined();
    });

    it('should accept optional timestamp', () => {
      const op: CreateOperation = {
        op: 'CREATE',
        id: 1,
        type: 'View',
        props: {},
        timestamp: Date.now(),
      };

      expect(op.timestamp).toBeDefined();
    });
  });

  describe('UpdateOperation', () => {
    it('should have correct structure', () => {
      const op: UpdateOperation = {
        op: 'UPDATE',
        id: 1,
        props: { style: { flex: 2 } },
      };

      expect(op.op).toBe('UPDATE');
      expect(op.id).toBe(1);
    });

    it('should accept optional removedProps', () => {
      const op: UpdateOperation = {
        op: 'UPDATE',
        id: 1,
        props: {},
        removedProps: ['testID', 'style'],
      };

      expect(op.removedProps).toEqual(['testID', 'style']);
    });
  });

  describe('AppendOperation', () => {
    it('should have correct structure', () => {
      const op: AppendOperation = {
        op: 'APPEND',
        id: 2,
        parentId: 1,
        childId: 2,
      };

      expect(op.op).toBe('APPEND');
      expect(op.parentId).toBe(1);
      expect(op.childId).toBe(2);
    });
  });

  describe('InsertOperation', () => {
    it('should have correct structure with index', () => {
      const op: InsertOperation = {
        op: 'INSERT',
        id: 3,
        parentId: 1,
        childId: 3,
        index: 0,
      };

      expect(op.op).toBe('INSERT');
      expect(op.index).toBe(0);
    });
  });

  describe('DeleteOperation', () => {
    it('should have minimal structure', () => {
      const op: DeleteOperation = {
        op: 'DELETE',
        id: 1,
      };

      expect(op.op).toBe('DELETE');
      expect(op.id).toBe(1);
    });
  });

  describe('RemoveOperation', () => {
    it('should have correct structure', () => {
      const op: RemoveOperation = {
        op: 'REMOVE',
        id: 2,
        parentId: 1,
        childId: 2,
      };

      expect(op.op).toBe('REMOVE');
      expect(op.parentId).toBe(1);
      expect(op.childId).toBe(2);
    });
  });

  describe('ReorderOperation', () => {
    it('should have correct structure with childIds array', () => {
      const op: ReorderOperation = {
        op: 'REORDER',
        id: 1,
        parentId: 1,
        childIds: [3, 1, 2],
      };

      expect(op.op).toBe('REORDER');
      expect(op.childIds).toEqual([3, 1, 2]);
    });
  });

  describe('TextOperation', () => {
    it('should have correct structure', () => {
      const op: TextOperation = {
        op: 'TEXT',
        id: 1,
        text: 'Hello World',
      };

      expect(op.op).toBe('TEXT');
      expect(op.text).toBe('Hello World');
    });
  });
});

describe('Serialized Types', () => {
  describe('SerializedValue', () => {
    it('should accept null', () => {
      const value: SerializedValue = null;
      expect(value).toBeNull();
    });

    it('should accept boolean', () => {
      const value: SerializedValue = true;
      expect(value).toBe(true);
    });

    it('should accept number', () => {
      const value: SerializedValue = 42;
      expect(value).toBe(42);
    });

    it('should accept string', () => {
      const value: SerializedValue = 'hello';
      expect(value).toBe('hello');
    });

    it('should accept array', () => {
      const value: SerializedValue = [1, 'two', true];
      expect(value).toEqual([1, 'two', true]);
    });

    it('should accept nested object', () => {
      const value: SerializedValue = {
        nested: {
          deep: {
            value: 123,
          },
        },
      };
      expect(value).toBeDefined();
    });
  });

  describe('SerializedFunction', () => {
    it('should have correct structure', () => {
      const fn: SerializedFunction = {
        __type: 'function',
        __fnId: 'fn_1_abc123',
      };

      expect(fn.__type).toBe('function');
      expect(fn.__fnId).toMatch(/^fn_/);
    });
  });

  describe('SerializedProps', () => {
    it('should accept mixed values', () => {
      const props: SerializedProps = {
        style: { flex: 1 },
        onPress: { __type: 'function', __fnId: 'fn_1' },
        data: [1, 2, 3],
        enabled: true,
        label: 'Button',
      };

      expect(Object.keys(props)).toHaveLength(5);
    });
  });
});

describe('Host Message Types', () => {
  describe('HostMsg enum', () => {
    it('should include all message types', () => {
      expect(HostMsg.CALL_FUNCTION).toBe('CALL_FUNCTION');
      expect(HostMsg.HOST_EVENT).toBe('HOST_EVENT');
      expect(HostMsg.CONFIG_UPDATE).toBe('CONFIG_UPDATE');
      expect(HostMsg.DESTROY).toBe('DESTROY');
      expect(HostMsg.PROMISE_RESOLVE).toBe('PROMISE_RESOLVE');
      expect(HostMsg.PROMISE_REJECT).toBe('PROMISE_REJECT');
      expect(HostMsg.REF_METHOD_RESULT).toBe('REF_METHOD_RESULT');
    });
  });

  describe('CallFunctionMessage', () => {
    it('should have correct structure', () => {
      const msg: CallFunctionMessage = {
        type: HostMsg.CALL_FUNCTION,
        fnId: 'fn_1',
        args: ['arg1', 123, true],
      };

      expect(msg.type).toBe(HostMsg.CALL_FUNCTION);
      expect(msg.fnId).toBe('fn_1');
      expect(msg.args).toHaveLength(3);
    });

    it('should accept optional seq', () => {
      const msg: CallFunctionMessage = {
        type: HostMsg.CALL_FUNCTION,
        fnId: 'fn_1',
        args: [],
        seq: 42,
      };

      expect(msg.seq).toBe(42);
    });
  });

  describe('HostEventMessage', () => {
    it('should have correct structure', () => {
      const msg: HostEventMessage = {
        type: HostMsg.HOST_EVENT,
        eventName: 'REFRESH',
        payload: { timestamp: Date.now() },
      };

      expect(msg.type).toBe(HostMsg.HOST_EVENT);
      expect(msg.eventName).toBe('REFRESH');
    });
  });

  describe('ConfigUpdateMessage', () => {
    it('should have correct structure', () => {
      const msg: ConfigUpdateMessage = {
        type: HostMsg.CONFIG_UPDATE,
        config: { theme: 'dark', fontSize: 16 },
      };

      expect(msg.type).toBe(HostMsg.CONFIG_UPDATE);
      expect(msg.config.theme).toBe('dark');
    });
  });

  describe('DestroyMessage', () => {
    it('should have minimal structure', () => {
      const msg: DestroyMessage = {
        type: HostMsg.DESTROY,
      };

      expect(msg.type).toBe(HostMsg.DESTROY);
    });
  });
});

describe('OperationBatch', () => {
  it('should have correct structure', () => {
    const batch: OperationBatch = {
      version: 1,
      batchId: 123,
      operations: [
        { op: 'CREATE', id: 1, type: 'View', props: {} },
        { op: 'APPEND', id: 1, parentId: 0, childId: 1 },
      ],
    };

    expect(batch.version).toBe(1);
    expect(batch.batchId).toBe(123);
    expect(batch.operations).toHaveLength(2);
  });
});

describe('VNode', () => {
  it('should have correct structure', () => {
    const node: VNode = {
      id: 1,
      type: 'View',
      props: { style: { flex: 1 } },
      children: [],
      parent: null,
    };

    expect(node.id).toBe(1);
    expect(node.type).toBe('View');
    expect(node.children).toEqual([]);
    expect(node.parent).toBeNull();
  });

  it('should support parent reference', () => {
    const parent: VNode = {
      id: 1,
      type: 'View',
      props: {},
      children: [],
      parent: null,
    };

    const child: VNode = {
      id: 2,
      type: 'Text',
      props: {},
      children: [],
      parent: parent,
    };

    parent.children.push(child);

    expect(child.parent).toBe(parent);
    expect(parent.children).toContain(child);
  });
});

describe('NodeInstance', () => {
  it('should have correct structure', () => {
    const node: NodeInstance = {
      id: 1,
      type: 'View',
      props: { style: { flex: 1 } },
      children: [2, 3],
    };

    expect(node.id).toBe(1);
    expect(node.children).toEqual([2, 3]);
  });
});

describe('StyleObject', () => {
  it('should support layout properties', () => {
    const style: StyleObject = {
      flex: 1,
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
    };

    expect(style.flex).toBe(1);
    expect(style.flexDirection).toBe('row');
  });

  it('should support spacing properties', () => {
    const style: StyleObject = {
      padding: 10,
      paddingHorizontal: 20,
      margin: 5,
      marginVertical: 15,
    };

    expect(style.padding).toBe(10);
    expect(style.marginVertical).toBe(15);
  });

  it('should support size properties', () => {
    const style: StyleObject = {
      width: 100,
      height: '50%',
      minWidth: 50,
      maxHeight: 200,
    };

    expect(style.width).toBe(100);
    expect(style.height).toBe('50%');
  });

  it('should support text properties', () => {
    const style: StyleObject = {
      color: '#333',
      fontSize: 16,
      fontWeight: 'bold',
      textAlign: 'center',
    };

    expect(style.fontSize).toBe(16);
    expect(style.fontWeight).toBe('bold');
  });

  it('should support transform', () => {
    const style: StyleObject = {
      transform: [{ translateX: 10 }, { translateY: 20 }, { scale: 1.5 }, { rotate: '45deg' }],
    };

    expect(style.transform).toHaveLength(4);
  });
});

describe('StyleProp', () => {
  it('should accept single style object', () => {
    const style: StyleProp = { flex: 1 };
    expect(style).toEqual({ flex: 1 });
  });

  it('should accept array of style objects', () => {
    const style: StyleProp = [{ flex: 1 }, { backgroundColor: 'red' }];
    expect(style).toHaveLength(2);
  });

  it('should accept undefined', () => {
    const style: StyleProp = undefined;
    expect(style).toBeUndefined();
  });
});
