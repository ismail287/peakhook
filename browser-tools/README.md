# Peak Automations browser tools

The source of the free tools at **<https://peakautomations.online/tools/>**, published so you can audit them or run them without our website.

Every tool runs entirely in your browser. Nothing you paste (workflows, webhook payloads, cURL commands, CSV files) is sent anywhere.

| Tool | Single-file offline edition | JavaScript the website loads |
|---|---|---|
| n8n & Make.com Workflow Sanitizer | [`n8n-workflow-sanitizer.html`](n8n-workflow-sanitizer.html) | [`js/n8n-workflow-sanitizer.js`](js/n8n-workflow-sanitizer.js) |
| Webhook PII Scrubber | [`webhook-pii-scrubber.html`](webhook-pii-scrubber.html) | [`js/webhook-pii-scrubber.js`](js/webhook-pii-scrubber.js) |
| Automation Cost Calculator | [`automation-cost-calculator.html`](automation-cost-calculator.html) | [`js/automation-cost-calculator.js`](js/automation-cost-calculator.js) |
| Cron Expression Visualizer | [`cron-expression-visualizer.html`](cron-expression-visualizer.html) | [`js/cron-expression-visualizer.js`](js/cron-expression-visualizer.js) |
| CSV Lead Sanitizer | [`csv-lead-sanitizer.html`](csv-lead-sanitizer.html) | [`js/csv-lead-sanitizer.js`](js/csv-lead-sanitizer.js) |
| cURL to n8n Converter | [`curl-to-n8n-converter.html`](curl-to-n8n-converter.html) | [`js/curl-to-n8n-converter.js`](js/curl-to-n8n-converter.js) + [`js/curl-parser.js`](js/curl-parser.js) |

`js/tools-core.js` holds the small helpers every tool shares (copy to clipboard, download a local file).

## Run them offline (no server at all)

Download any `*.html` file and double-click it. It opens from `file://` and works with Wi-Fi off.

Each file contains all of its HTML, CSS and JavaScript, uses no web fonts, icons or CDNs, and declares this Content-Security-Policy:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none';
form-action 'none'; base-uri 'none'
```

`connect-src 'none'` means the browser itself refuses any `fetch`, XHR, WebSocket or beacon the page might try. You do not have to trust the code for that.

You can also get the same file from each tool page on the website with the **Download Single-File Offline HTML** button. That button works offline too: the file is fetched once while the page loads, and the click only builds a local download.

### Check that your copy is unmodified

```bash
sha256sum -c SHA256SUMS.txt          # Linux
shasum -a 256 -c SHA256SUMS.txt      # macOS
```

On Windows PowerShell: `Get-FileHash .\curl-to-n8n-converter.html -Algorithm SHA256`, then compare with the line in `SHA256SUMS.txt`.

## Serve them locally

With Node.js:

```bash
npx serve browser-tools
```

Then open the URL it prints (usually <http://localhost:3000>).

With Docker:

```bash
docker build -t peak-browser-tools browser-tools
docker run --rm -p 8080:80 peak-browser-tools
```

Then open <http://localhost:8080>.

## How these files are produced

The website pages and these files come from the same source. The `*.html` offline editions are generated from the live tool pages and their JavaScript files, and the `js/` files are byte-for-byte the files <https://peakautomations.online> serves. Compare them yourself:

```bash
curl -s https://peakautomations.online/js/tools/curl-to-n8n-converter.js | diff - browser-tools/js/curl-to-n8n-converter.js
curl -s https://peakautomations.online/tools/offline/curl-to-n8n-converter.html | diff - browser-tools/curl-to-n8n-converter.html
```

The website itself also loads Google AdSense, Google Fonts and Font Awesome for layout and ads. Those scripts are not involved in the tools. If you want zero third-party code, use the offline editions.

## License

MIT, see [`../LICENSE`](../LICENSE). Built by [Peak Automations](https://peakautomations.online).
