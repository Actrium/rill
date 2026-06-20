(() => {
  var arr = [];
  for (var i = 0; i < 100000; i++) arr.push(i);
  var result = arr
    .map((x) => x * 2)
    .filter((x) => x % 3 === 0)
    .reduce((a, b) => a + b, 0);
  return result;
})();
