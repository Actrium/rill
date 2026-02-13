var React = require('react');
var useState = React.useState;
var useCallback = React.useCallback;
var render = require('rill/reconciler').render;
var h = React.createElement;

function GuestApp() {
  var countState = useState(0);
  var count = countState[0];
  var setCount = countState[1];

  var handleIncrement = useCallback(function () {
    setCount(function (c) {
      return c + 1;
    });
  }, []);
  var handleDecrement = useCallback(function () {
    setCount(function (c) {
      return c - 1;
    });
  }, []);
  var handleReset = useCallback(function () {
    setCount(0);
  }, []);

  return h(
    'ScrollView',
    { style: { flex: 1, backgroundColor: '#0f0f1a' } },
    h(
      'View',
      { style: { padding: 20, paddingTop: 12 } },
      h(
        'Text',
        { style: { fontSize: 22, fontWeight: '700', color: '#fff', marginBottom: 4 } },
        'Rill Windows Demo'
      ),
      h(
        'Text',
        { style: { fontSize: 12, color: '#555', marginBottom: 24 } },
        'Guest UI rendered via sandbox engine'
      ),
      h(
        'View',
        { style: { marginBottom: 24 } },
        h(
          'Text',
          {
            style: {
              fontSize: 11,
              fontWeight: '700',
              color: '#888',
              letterSpacing: 1,
              marginBottom: 8,
            },
          },
          'COUNTER'
        ),
        h(
          'View',
          {
            style: {
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
            },
          },
          h(
            'TouchableOpacity',
            {
              style: {
                width: 56,
                height: 56,
                borderRadius: 12,
                backgroundColor: '#1e1e3a',
                alignItems: 'center',
                justifyContent: 'center',
              },
              onPress: handleDecrement,
            },
            h(
              'Text',
              { style: { fontSize: 28, color: '#fff', fontWeight: '300' } },
              String.fromCharCode(8722)
            )
          ),
          h(
            'Text',
            {
              style: {
                fontSize: 48,
                fontWeight: '700',
                color: '#fff',
                minWidth: 80,
                textAlign: 'center',
                marginHorizontal: 16,
              },
            },
            '' + count
          ),
          h(
            'TouchableOpacity',
            {
              style: {
                width: 56,
                height: 56,
                borderRadius: 12,
                backgroundColor: '#1e1e3a',
                alignItems: 'center',
                justifyContent: 'center',
              },
              onPress: handleIncrement,
            },
            h('Text', { style: { fontSize: 28, color: '#fff', fontWeight: '300' } }, '+')
          )
        ),
        h(
          'TouchableOpacity',
          {
            style: {
              alignSelf: 'center',
              paddingHorizontal: 20,
              paddingVertical: 8,
              borderRadius: 6,
              backgroundColor: '#2a2a4a',
            },
            onPress: handleReset,
          },
          h('Text', { style: { fontSize: 13, color: '#888' } }, 'Reset')
        )
      ),
      h(
        'View',
        { style: { marginBottom: 24 } },
        h(
          'Text',
          {
            style: {
              fontSize: 11,
              fontWeight: '700',
              color: '#888',
              letterSpacing: 1,
              marginBottom: 8,
            },
          },
          'LAYOUT'
        ),
        h(
          'View',
          { style: { flexDirection: 'row', justifyContent: 'space-around' } },
          h(
            'View',
            {
              style: {
                width: 72,
                height: 72,
                borderRadius: 12,
                backgroundColor: '#e74c3c',
                alignItems: 'center',
                justifyContent: 'center',
              },
            },
            h('Text', { style: { fontSize: 20, fontWeight: '700', color: '#fff' } }, 'R')
          ),
          h(
            'View',
            {
              style: {
                width: 72,
                height: 72,
                borderRadius: 12,
                backgroundColor: '#2ecc71',
                alignItems: 'center',
                justifyContent: 'center',
              },
            },
            h('Text', { style: { fontSize: 20, fontWeight: '700', color: '#fff' } }, 'G')
          ),
          h(
            'View',
            {
              style: {
                width: 72,
                height: 72,
                borderRadius: 12,
                backgroundColor: '#3498db',
                alignItems: 'center',
                justifyContent: 'center',
              },
            },
            h('Text', { style: { fontSize: 20, fontWeight: '700', color: '#fff' } }, 'B')
          )
        )
      ),
      h(
        'View',
        null,
        h(
          'Text',
          {
            style: {
              fontSize: 11,
              fontWeight: '700',
              color: '#888',
              letterSpacing: 1,
              marginBottom: 8,
            },
          },
          'INFO'
        ),
        h(
          'Text',
          { style: { fontSize: 12, color: '#555' } },
          'Guest code runs in a sandboxed engine. State, callbacks, and rendering all work through the Rill bridge.'
        )
      )
    )
  );
}

render(h(GuestApp), globalThis.__rill_sendBatch);
