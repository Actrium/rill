(() => {
  var data = [];
  for (var i = 0; i < 10000; i++) {
    data.push({ id: i, name: `item${i}`, value: Math.random() });
  }
  var json = JSON.stringify(data);
  var parsed = JSON.parse(json);
  return parsed.length;
})();
