(() => {
  var str = '';
  for (var i = 0; i < 10000; i++) {
    str += `hello world ${i} `;
  }
  var matches = str.match(/world/g);
  return matches ? matches.length : 0;
})();
