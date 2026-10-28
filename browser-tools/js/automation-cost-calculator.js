/* PeakAutomations free tool: automation-cost-calculator
   Source of https://peakautomations.online/tools/automation-cost-calculator/
   Runs entirely in the browser. Needs /js/tools-core.js (window.PeakTools). MIT licensed. */
(function () {
  var T = window.PeakTools, $ = T.$;

  // Approximate public list prices, USD / month, annual billing. [units, price]
  var ZAP = [[100,0],[750,19.99],[1500,39],[2000,49],[5000,69],[10000,103.5],[20000,193.5],[50000,373.5],[100000,589.5],[200000,799.5],[500000,1199]];
  var MAKE = [[1000,0],[10000,9],[20000,16],[40000,29],[80000,55],[150000,99],[300000,189],[500000,299],[750000,439],[1000000,599],[2000000,1199]];
  // Self-hosted: [max executions per month, VPS $/month, label]
  var VPS = [[30000,5,'1 vCPU / 4 GB'],[150000,7,'2 vCPU / 8 GB'],[500000,10,'4 vCPU / 16 GB'],[Infinity,20,'8 vCPU / 32 GB']];
  var CURVE = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

  function tier(table, units) {
    for (var i = 0; i < table.length; i++) if (units <= table[i][0]) return table[i];
    var last = table[table.length - 1], prev = table[table.length - 2];
    var per = (last[1] - prev[1]) / (last[0] - prev[0]);
    return [units, last[1] + per * (units - last[0])]; // extrapolate beyond the top tier
  }
  function money(n) { return '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2).replace(/\.00$/, '')); }
  function runsFromSlider(v) { // 100 .. 1,000,000 (log scale), rounded to 2 significant figures
    var x = Math.pow(10, 2 + (v / 1000) * 4), mag = Math.pow(10, Math.floor(Math.log10(x)) - 1);
    return Math.round(x / mag) * mag;
  }
  function sliderFromRuns(r) { return Math.round((Math.log10(Math.max(100, r)) - 2) / 4 * 1000); }

  function compute(runs, steps, o) {
    var tasks = runs * Math.max(0, steps - 1), ops = runs * steps;
    var z = tier(ZAP, tasks), m = tier(MAKE, ops);
    var v = VPS.filter(function (x) { return runs <= x[0]; })[0];
    var vpsPrice = (o.vpsOverride !== null && o.vpsOverride >= 0) ? o.vpsOverride : v[1];
    var time = o.hours * o.rate;
    return {
      zapier: { cost: z[1], note: tasks.toLocaleString('en-US') + ' tasks / month' + (tasks <= 100 ? ' (free plan)' : '') },
      make:   { cost: m[1], note: ops.toLocaleString('en-US') + ' operations / month' + (ops <= 1000 ? ' (free plan)' : '') },
      n8n:    { cost: vpsPrice, withTime: vpsPrice + time, note: runs.toLocaleString('en-US') + ' executions · ' + v[2] + ' VPS' }
    };
  }

  function read() {
    var vo = $('vpsOverride').value;
    return {
      runs: runsFromSlider(+$('runsRange').value),
      steps: Math.max(1, +$('steps').value || 1),
      o: { vpsOverride: vo === '' ? null : +vo, hours: Math.max(0, +$('hours').value || 0), rate: Math.max(0, +$('rate').value || 0) }
    };
  }

  function render() {
    var s = read(), r = compute(s.runs, s.steps, s.o);
    $('runsOut').textContent = s.runs.toLocaleString('en-US');
    var cash = Math.min(r.zapier.cost, r.make.cost, r.n8n.cost);
    var cheapestKey = r.n8n.cost === cash ? 'n8n' : (r.make.cost === cash ? 'make' : 'zapier');
    function card(key, title, data, extra) {
      return '<div class="cost-card' + (cheapestKey === key ? ' best' : '') + '"><h3>' + title + '</h3><div class="price">' + money(data.cost) +
        '<span style="font-size:.9rem;font-weight:600;color:var(--muted)"> /mo</span></div><small>' + T.esc(data.note) + '<br>' + money(data.cost * 12) + ' per year' + (extra || '') + '</small></div>';
    }
    $('cards').innerHTML = card('zapier', 'Zapier (Professional)', r.zapier) + card('make', 'Make.com (Core)', r.make) +
      card('n8n', 'Self-hosted n8n (VPS)', r.n8n, s.o.hours * s.o.rate > 0 ? '<br>' + money(r.n8n.withTime) + '/mo including ' + s.o.hours + ' h of your time' : '');
    var save = r.zapier.cost - r.n8n.cost, saveT = r.zapier.cost - r.n8n.withTime;
    var m = $('msg'); m.className = 'tool-msg ok';
    if (r.zapier.cost === 0 && r.make.cost === 0) { m.className = 'tool-msg'; m.textContent = 'At this volume the free plans of Zapier and Make cover you. Self-hosting only pays off at higher volume.'; }
    else m.textContent = 'Self-hosted n8n vs Zapier: ' + (save >= 0 ? 'saves ' : 'costs ') + money(Math.abs(save) * 12) + ' per year in cash' +
      (s.o.hours * s.o.rate > 0 ? ', or ' + (saveT >= 0 ? 'saves ' : 'costs ') + money(Math.abs(saveT) * 12) + ' per year once your maintenance time is counted.' : '.');

    var rows = '<tr><th>Runs / month</th><th>Zapier</th><th>Make.com</th><th>Self-hosted n8n</th></tr>';
    CURVE.forEach(function (runs) {
      var c = compute(runs, s.steps, s.o), best = Math.min(c.zapier.cost, c.make.cost, c.n8n.cost);
      function td(v) { return '<td' + (v === best ? ' style="color:var(--teal);font-weight:700"' : '') + '>' + money(v) + '</td>'; }
      rows += '<tr><td>' + runs.toLocaleString('en-US') + '</td>' + td(c.zapier.cost) + td(c.make.cost) + td(c.n8n.cost) + '</tr>';
    });
    $('curve').innerHTML = rows;
  }

  ['runsRange', 'steps', 'vpsOverride', 'hours', 'rate'].forEach(function (id) { $(id).addEventListener('input', render); });
  $('sample').onclick = function () {
    $('runsRange').value = sliderFromRuns(25000); $('steps').value = 6; $('vpsOverride').value = ''; $('hours').value = 1; $('rate').value = 30; render();
  };
  $('reset').onclick = function () {
    $('runsRange').value = 500; $('steps').value = 5; $('vpsOverride').value = ''; $('hours').value = 1; $('rate').value = 30; render();
  };
  render();
})();
