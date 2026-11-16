/* AI Reader — preferences pane script (runs in the prefs sandbox) */
/* NOTE: Zotero loads this script BEFORE the pane markup is inserted into the
   DOM, so we must wait for the elements to appear before binding. */

(function () {
  function pget(key) {
    return Zotero.Prefs.get("aireader." + key);
  }

  function normBase(raw) {
    let b = (raw || "").trim().replace(/\/+$/, "");
    if (!b) return b;
    const m = b.match(/^http:\/\/([^/]+)/);
    if (m && !/^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(m[1])) b = b.replace(/^http:\/\//i, "https://");
    if (/^https?:\/\/[^/]+$/.test(b)) b += "/v1"; // bare host -> add /v1
    return b;
  }

  function fmtNow() {
    const f = (pget("apiFormat") || "chat");
    return ["chat", "responses", "anthropic"].includes(f) ? f : "chat";
  }

  function buildReq(fmt, base, model, key) {
    const msgs = [{ role: "user", content: "ping" }];
    if (fmt === "responses") {
      return { url: base + "/responses", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: { model, input: msgs, max_output_tokens: 16, stream: false } };
    }
    if (fmt === "anthropic") {
      return { url: base + "/messages", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: { model, messages: msgs, max_tokens: 16, stream: false } };
    }
    return { url: base + "/chat/completions", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: { model, messages: msgs, max_tokens: 16, stream: false } };
  }

  async function runTest(result) {
    result.textContent = "…";
    result.style.color = "";
    try {
      const base = normBase(pget("baseURL"));
      if (!base) throw new Error("Base URL 为空");
      if (!pget("apiKey")) throw new Error("API Key 为空");
      const fmt = fmtNow();
      const req = buildReq(fmt, base, pget("model"), pget("apiKey"));
      const resp = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
      const raw = await resp.text();
      if (!resp.ok) {
        // Real server response, not a masked hint.
        throw new Error("HTTP " + resp.status + " " + resp.statusText + " @ " + req.url + "\n" + raw.slice(0, 600));
      }
      let data;
      try { data = JSON.parse(raw); }
      catch (e) { throw new Error("响应不是 JSON @ " + req.url + "\n实际返回：\n" + raw.slice(0, 600)); }
      if (data.error) throw new Error((data.error.message || JSON.stringify(data.error)));
      result.style.color = "green";
      result.textContent = "OK · " + (data.model || pget("model") || "连通") + " · " + fmt;
    } catch (e) {
      result.style.color = "red";
      result.textContent = String(e.message || e);
    }
  }

  function attach() {
    const btn = document.getElementById("aireader-test");
    const result = document.getElementById("aireader-test-result");
    if (!btn || !result) return false;
    if (btn._aireaderBound) return true;
    btn._aireaderBound = true;
    const handler = () => runTest(result);
    // XUL <button> fires "command"; also bind "click" as a safety net.
    btn.addEventListener("command", handler);
    btn.addEventListener("click", handler);
    return true;
  }

  // The pane markup is inserted asynchronously after this script runs, so
  // retry until the button exists (up to ~4s).
  let tries = 0;
  (function retry() {
    if (attach()) return;
    if (tries++ > 40) {
      Zotero.debug("[AIReader] prefs: test button not found after retries");
      return;
    }
    setTimeout(retry, 100);
  })();
})();
