var x = require('./index');
var apps = x.discover();
var reg = x.loadRegistry();
apps.forEach(function (a) {
  var entry = Object.entries(reg).find(function (e) { return e[1] && x.sameAsarPath(e[1].asarPath, a.asarPath); });
  console.log(a.name, '→ registeredName:', entry ? entry[0] : null);
});
