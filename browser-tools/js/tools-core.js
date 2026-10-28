/* ════════════════════════════════════════════════
   PEAK AUTOMATIONS — TOOLS CORE (window.PeakTools)
   Tiny helpers every tool uses. No network access:
   copy uses the Clipboard API, download builds a
   local Blob. Also bundled into the offline editions.
   ════════════════════════════════════════════════ */
(function () {
  window.PeakTools = {
    $: function (id) { return document.getElementById(id); },
    esc: function (s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    copy: function (text, btn) {
      var done = function () {
        if (!btn) return;
        var old = btn.getAttribute('data-label') || btn.innerHTML;
        btn.setAttribute('data-label', old);
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
        setTimeout(function () { btn.innerHTML = old; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(); });
      } else { fallback(); }
      function fallback() {
        var t = document.createElement('textarea');
        t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
        document.body.removeChild(t);
      }
    },
    download: function (name, text, type) {
      var blob = new Blob([text], { type: type || 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
  };
})();
