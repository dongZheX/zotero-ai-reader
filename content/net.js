/* net.js — LLM transport layer: request/response shaping per API format
 * (chat/responses/anthropic), streaming + tool-call/reasoning accumulation,
 * abort + timeout + 429 retry, and the error→friendly-hint mapping. Moved out
 * of aireader.js verbatim (pure move). _fmt / _normBase stay in the core.
 * Attaches to the global AIReader via Object.assign. */

Object.assign(AIReader, {
  _temperature() {
    const raw = (this.getPref("temperature") == null ? "" : this.getPref("temperature")).toString().trim();
    if (raw === "") return null;
    const t = parseFloat(raw);
    return isNaN(t) ? null : t;
  },
  _anthropicCacheMsgs(msgs) {
    if (!msgs.length) return msgs;
    const out = msgs.slice();
    const last = out[out.length - 1];
    const CC = { type: "ephemeral" };
    if (Array.isArray(last.content) && last.content.length) {
      const blocks = last.content.map((b) => ({ ...b }));
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CC };
      out[out.length - 1] = { ...last, content: blocks };
    } else if (typeof last.content === "string") {
      out[out.length - 1] = { ...last, content: [{ type: "text", text: last.content, cache_control: CC }] };
    }
    return out;
  },
  _toolBody(fmt, messages, tools, stream) {
    const model = this.getPref("model");
    const temp = this._temperature(); // null → omit (use model default)
    const mtRaw = parseInt(this.getPref("maxTokens"), 10); const maxTok = isNaN(mtRaw) || mtRaw <= 0 ? 0 : mtRaw;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    if (fmt === "anthropic") {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const msgs = this._anthropicCacheMsgs(messages.filter((m) => m.role !== "system"));
      const body = { model, messages: msgs, max_tokens: maxTok || 32000, stream: !!stream };
      if (temp != null) body.temperature = temp;
      if (hasTools) body.tools = tools;
      // Cache the large, stable system prompt (paper context) so multi-turn
      // requests on the same paper hit the prompt cache instead of re-billing it.
      if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      return JSON.stringify(body);
    }
    if (fmt === "responses") {
      const body = { model, input: messages, stream: !!stream };
      if (temp != null) body.temperature = temp;
      if (hasTools) { body.tools = tools; body.tool_choice = "auto"; }
      if (maxTok) body.max_output_tokens = maxTok;
      return JSON.stringify(body);
    }
    const body = { model, messages, stream: !!stream };
    if (temp != null) body.temperature = temp;
    if (hasTools) { body.tools = tools; body.tool_choice = "auto"; }
    if (maxTok) body.max_tokens = maxTok;
    if (stream) body.stream_options = { include_usage: true };
    return JSON.stringify(body);
  },
  // Accumulate streamed tool-call fragments into `tc` (keyed by index).
  _streamToolDelta(fmt, j, tc) {
    if (fmt === "anthropic") {
      if (j.type === "content_block_start" && j.content_block && j.content_block.type === "tool_use") tc[j.index] = { id: j.content_block.id, name: j.content_block.name, args: "" };
      else if (j.type === "content_block_delta" && j.delta && j.delta.type === "input_json_delta" && tc[j.index]) tc[j.index].args += j.delta.partial_json || "";
      return;
    }
    if (fmt === "responses") {
      if (j.type === "response.output_item.added" && j.item && j.item.type === "function_call") tc[j.output_index] = { id: j.item.call_id || j.item.id, name: j.item.name, args: "" };
      else if (j.type === "response.function_call_arguments.delta" && tc[j.output_index]) tc[j.output_index].args += j.delta || "";
      return;
    }
    const arr = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.tool_calls;
    if (Array.isArray(arr)) for (const t of arr) { const i = t.index || 0; tc[i] = tc[i] || { id: "", name: "", args: "" }; if (t.id) tc[i].id = t.id; if (t.function) { if (t.function.name) tc[i].name = t.function.name; if (t.function.arguments) tc[i].args += t.function.arguments; } }
  },
  _finalizeToolCalls(tc) {
    return Object.keys(tc).sort((a, b) => a - b).map((k) => ({ id: tc[k].id, name: tc[k].name, args: this._safeJSON(tc[k].args) })).filter((c) => c.name);
  },
  // Accumulate the model's REASONING so it can be fed back verbatim on the next
  // round — required for multi-turn tool use: Anthropic rejects a follow-up whose
  // assistant turn drops the thinking block (it must keep its signature), and
  // OpenAI /responses needs the reasoning item returned with its id. (litellm does
  // the same "preserve & replay" for both.) Chat Completions has no such token.
  _streamReasoningDelta(fmt, j, racc) {
    if (fmt === "anthropic") {
      if (j.type === "content_block_start" && j.content_block) {
        if (j.content_block.type === "thinking") racc[j.index] = { type: "thinking", thinking: j.content_block.thinking || "", signature: j.content_block.signature || "" };
        else if (j.content_block.type === "redacted_thinking") racc[j.index] = { type: "redacted_thinking", data: j.content_block.data || "" };
      } else if (j.type === "content_block_delta" && j.delta && racc[j.index]) {
        if (j.delta.type === "thinking_delta") racc[j.index].thinking += j.delta.thinking || "";
        else if (j.delta.type === "signature_delta") racc[j.index].signature = (racc[j.index].signature || "") + (j.delta.signature || "");
      }
      return;
    }
    if (fmt === "responses") {
      // keep the whole reasoning item (id / summary / encrypted_content) verbatim
      if ((j.type === "response.output_item.added" || j.type === "response.output_item.done") && j.item && j.item.type === "reasoning") racc[j.output_index] = j.item;
      return;
    }
  },
  _finalizeReasoning(racc) {
    const keys = Object.keys(racc);
    return keys.length ? keys.sort((a, b) => a - b).map((k) => racc[k]).filter(Boolean) : [];
  },
  // Streamed turn that returns both the streamed text and any tool calls.
  async _streamAnswer(messages, tools, onDelta, shouldStop, meta) {
    meta = meta || {};
    const fmt = this._fmt();
    const ab = this._abortGuard(shouldStop); // Stop button aborts the fetch/stream even mid-connection
    try {
      // Long streamed answers can take minutes; the default 60s abort would cut
      // the stream mid-sentence, so give streaming a generous ceiling and no retry.
      const resp = await this._fetchLLM(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._toolBody(fmt, messages, tools, true) }, { timeoutMs: 600000, retries: 0, abortSignal: ab.signal });
      if (!resp.ok) { const raw = await resp.text().catch(() => ""); throw this._fail(resp, raw); }
      if (!resp.body || typeof resp.body.getReader !== "function") {
        const raw = await resp.text(); const data = this._parseOrThrow(raw);
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        this._captureUsage(meta, data);
        const parsed = this._parseToolCalls(fmt, data);
        if (parsed.text) onDelta(parsed.text);
        return { text: parsed.text, calls: parsed.calls, reasoning: parsed.reasoning || [] };
      }
      const reader = resp.body.getReader(); const dec = new TextDecoder();
      let buf = "", text = ""; const tc = {}; const racc = {};
      while (true) {
        if (shouldStop && shouldStop()) { try { await reader.cancel(); } catch (e) {} break; }
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line || !line.startsWith("data:")) continue;
          const payload = line.slice(5).trim(); if (payload === "[DONE]") continue;
          let j; try { j = JSON.parse(payload); } catch (e) { continue; }
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          this._captureUsage(meta, j);
          const d = this._streamDelta(fmt, j); if (d) { text += d; onDelta(d); }
          this._streamToolDelta(fmt, j, tc);
          this._streamReasoningDelta(fmt, j, racc);
        }
      }
      return { text, calls: this._finalizeToolCalls(tc), reasoning: this._finalizeReasoning(racc) };
    } finally { ab.dispose(); }
  },

  // AbortController is NOT a global in the bootstrap sandbox (only the main
  // window exposes it), but a window-created signal DOES abort the sandbox
  // `fetch`. Always source it from the window — using a bare (absent)
  // AbortController silently disabled both cancel and the request timeout.
  _abortCtor() {
    try { const w = Zotero.getMainWindow && Zotero.getMainWindow(); if (w && typeof w.AbortController === "function") return w.AbortController; } catch (e) {}
    return (typeof AbortController === "function") ? AbortController : null;
  },

  // Bridge a `shouldStop()` flag to a real AbortController so a hung request
  // (connection open, no bytes) can actually be cancelled: poll the flag and
  // abort the moment it flips. Returns { signal, dispose }. Degrades to a no-op
  // signal where AbortController/timers aren't available.
  _abortGuard(shouldStop) {
    const AC = this._abortCtor();
    const ac = AC ? new AC() : null;
    const win = Zotero.getMainWindow && Zotero.getMainWindow();
    let iv = null;
    if (ac && shouldStop && win && typeof win.setInterval === "function") {
      iv = win.setInterval(() => { try { if (shouldStop()) { ac.abort(); if (win.clearInterval) win.clearInterval(iv); iv = null; } } catch (e) {} }, 150);
    }
    return { signal: ac ? ac.signal : undefined, dispose: () => { try { if (iv && win && win.clearInterval) win.clearInterval(iv); } catch (e) {} iv = null; } };
  },
  _safeJSON(s) { if (s && typeof s === "object") return s; try { return JSON.parse(s || "{}"); } catch (e) { return {}; } },
  _parseToolCalls(fmt, data) {
    if (fmt === "anthropic") {
      const content = Array.isArray(data.content) ? data.content : [];
      let text = ""; const calls = [], reasoning = [];
      for (const c of content) {
        if (c.type === "text") text += c.text || "";
        else if (c.type === "tool_use") calls.push({ id: c.id, name: c.name, args: c.input || {} });
        else if (c.type === "thinking" || c.type === "redacted_thinking") reasoning.push(c);
      }
      return { text, calls, reasoning, raw: content };
    }
    if (fmt === "responses") {
      const out = Array.isArray(data.output) ? data.output : [];
      let text = ""; const calls = [], reasoning = [];
      for (const o of out) {
        if (o.type === "function_call") calls.push({ id: o.call_id || o.id, name: o.name, args: this._safeJSON(o.arguments) });
        else if (o.type === "reasoning") reasoning.push(o);
        else if (o.type === "message" && Array.isArray(o.content)) text += o.content.map((x) => x.text || "").join("");
      }
      if (typeof data.output_text === "string" && data.output_text) text = data.output_text;
      return { text, calls, reasoning, raw: out };
    }
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const calls = (msg.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function && tc.function.name, args: this._safeJSON(tc.function && tc.function.arguments) }));
    return { text: msg.content || "", calls, reasoning: [], raw: msg };
  },
  _endpointFor(fmt) { const base = this._normBase(); if (!base) throw new Error("Base URL is not set."); if (fmt === "responses") return base + "/responses"; if (fmt === "anthropic") return base + "/messages"; return base + "/chat/completions"; },
  _headersFor(fmt) { const key = this.getPref("apiKey"); if (fmt === "anthropic") return { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }; return { "Content-Type": "application/json", Authorization: "Bearer " + key }; },
  _bodyFor(fmt, messages, stream) {
    const model = this.getPref("model");
    const temp = this._temperature(); // null → omit (use model default)
    // maxTokens: 0 (or unset) => do not cap (Anthropic requires the field, so use a generous fallback).
    const mtRaw = parseInt(this.getPref("maxTokens"), 10);
    const maxTok = isNaN(mtRaw) || mtRaw <= 0 ? 0 : mtRaw;
    if (fmt === "responses") {
      const body = { model, input: messages, stream: !!stream };
      if (temp != null) body.temperature = temp;
      if (maxTok) body.max_output_tokens = maxTok;
      return JSON.stringify(body);
    }
    if (fmt === "anthropic") {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const msgs = this._anthropicCacheMsgs(messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })));
      // Anthropic requires max_tokens; when uncapped, request a large ceiling so answers aren't truncated.
      const body = { model, messages: msgs, max_tokens: maxTok || 32000, stream: !!stream };
      if (temp != null) body.temperature = temp;
      if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      return JSON.stringify(body);
    }
    const body = { model, messages, stream: !!stream };
    if (temp != null) body.temperature = temp;
    if (maxTok) body.max_tokens = maxTok;
    if (stream) body.stream_options = { include_usage: true }; // OpenAI usage in final chunk
    return JSON.stringify(body);
  },

  _captureUsage(meta, j) {
    const u = j.usage || (j.message && j.message.usage) || (j.response && j.response.usage);
    if (u) {
      if (u.prompt_tokens != null) meta.inTok = u.prompt_tokens;
      if (u.input_tokens != null) meta.inTok = u.input_tokens;
      if (u.completion_tokens != null) meta.outTok = u.completion_tokens;
      if (u.output_tokens != null) meta.outTok = u.output_tokens;
      // prompt-cache hits (Anthropic) / cached_tokens (OpenAI) so savings are visible
      if (u.cache_read_input_tokens != null) meta.cacheRead = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens != null) meta.cacheWrite = u.cache_creation_input_tokens;
      if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens != null) meta.cacheRead = u.prompt_tokens_details.cached_tokens;
    }
  },
  _extractContent(fmt, data) {
    if (fmt === "responses") { if (typeof data.output_text === "string") return data.output_text; if (Array.isArray(data.output)) return data.output.map((o) => Array.isArray(o.content) ? o.content.map((c) => c.text || "").join("") : "").join(""); return undefined; }
    if (fmt === "anthropic") { if (Array.isArray(data.content)) return data.content.map((c) => c.text || "").join(""); return undefined; }
    const msg = data.choices && data.choices[0] && data.choices[0].message; return msg && msg.content;
  },
  _streamDelta(fmt, j) {
    if (fmt === "responses") return (j.type && /output_text\.delta$/.test(j.type)) ? (j.delta || "") : "";
    if (fmt === "anthropic") return (j.type === "content_block_delta" && j.delta) ? (j.delta.text || "") : "";
    return (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || "";
  },
  _fail(resp, raw) { return new Error("HTTP " + resp.status + " " + resp.statusText + "\n" + (raw || "").slice(0, 1200)); },

  // Turn a raw error into a short, actionable Chinese hint (keeps the original
  // text appended, so a wrong Base URL / format / key is diagnosable at a glance
  // instead of a bare "Error: HTTP 401 …").
  _friendlyError(e) {
    const raw = (e && e.message) ? String(e.message) : String(e || "出错了");
    const m = raw.toLowerCase();
    if (/base url 未设置|api key 未设置/.test(raw)) return raw; // already clear + actionable
    const tip = (t) => t + "\n\n（原始信息：" + raw.slice(0, 300) + "）";
    if (/abort|timeout|timed ?out/.test(m)) return tip("请求超时。回答太长或网络较慢时容易这样——可以重试，或在设置里调小「最大发送字符数」。");
    if (/http 401|http 403|unauthorized|forbidden|invalid.?api.?key|invalid_api_key/.test(m)) return tip("API Key 无效或没有权限。到设置里确认 Key，以及它是否对应当前 Base URL 的服务。");
    if (/http 404|not found|no such|unknown model|does not exist/.test(m)) return tip("接口或模型找不到。检查 Base URL、「接口格式」和模型名是否匹配。");
    if (/http 429|rate.?limit|too many requests|quota/.test(m)) return tip("触发限流或额度不足。稍等再试，或换一个 Key / 模型。");
    if (/http 5\d\d|internal server|bad gateway|service unavailable|overloaded/.test(m)) return tip("服务端出错（5xx），通常是对面临时故障，稍后重试。");
    if (/network|failed to fetch|fetch failed|enotfound|econnrefused|socket hang|dns|网络请求失败/.test(m)) return tip("连不上接口。检查网络、Base URL 是否正确、是否需要代理。");
    if (/无法提取结构化文本|无法提取正文|没有可翻译/.test(raw)) return tip("读不出这个文档的正文。扫描版/图片 PDF 需要先 OCR；网页快照/EPub 等非 PDF 附件可能不受支持。");
    if (/非 json|not json|unexpected token|无法从响应/.test(m)) return tip("返回的内容不是预期格式。多半是 Base URL 或「接口格式」选错了（比如给 OpenAI 服务选了 Anthropic 格式）。");
    return raw;
  },
  _parseOrThrow(raw) { try { return JSON.parse(raw); } catch (e) { throw new Error("响应不是 JSON（Base URL 或 API 格式可能不对）。实际返回：\n" + (raw || "").slice(0, 1200)); } },

  // Parse a Retry-After header → ms to wait, or null. Accepts delta-seconds or
  // an HTTP-date. Clamped so a hostile/huge value can't hang us for minutes.
  _retryAfterMs(resp) {
    try {
      const h = resp && resp.headers && resp.headers.get && (resp.headers.get("retry-after") || resp.headers.get("Retry-After"));
      if (!h) return null;
      const s = String(h).trim();
      if (/^\d+$/.test(s)) return Math.min(parseInt(s, 10) * 1000, 30000);
      const t = Date.parse(s);
      if (!isNaN(t)) return Math.max(0, Math.min(t - Date.now(), 30000));
    } catch (e) {}
    return null;
  },
  // Abortable sleep: resolves after ms, or early (returns false) if cancelled.
  _sleep(ms, abortSignal) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { if (onAbort && abortSignal) abortSignal.removeEventListener("abort", onAbort); } catch (e) {} resolve(v); };
      const timer = setTimeout(() => fin(true), ms);
      let onAbort = null;
      if (abortSignal) {
        if (abortSignal.aborted) { clearTimeout(timer); return fin(false); }
        onAbort = () => { clearTimeout(timer); fin(false); };
        try { abortSignal.addEventListener("abort", onAbort, { once: true }); } catch (e) {}
      }
    });
  },
  // fetch with an idle timeout and one automatic retry on a *network* failure
  // (connection reset / empty reply — the transient errors we actually hit).
  // Additionally, a 429 (rate limit) or 503/529 (overloaded) RESPONSE — which
  // always arrives before any stream bytes, so retrying can't dupe an answer —
  // is retried with backoff (honoring Retry-After), independent of `retries`.
  // Other HTTP errors (4xx/5xx with a body) are returned as-is and NOT retried.
  async _fetchLLM(url, opts, cfg) {
    cfg = cfg || {};
    const timeoutMs = cfg.timeoutMs || 60000;
    const retries = cfg.retries == null ? 1 : cfg.retries;
    const rateRetries = cfg.rateRetries == null ? 4 : cfg.rateRetries;
    let lastErr, attempt = 0, rateAttempt = 0;
    while (true) {
      const AC = this._abortCtor();
      const ctrl = AC ? new AC() : null;
      const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs) : null;
      // An external signal (the Stop button) aborts this fetch AND its in-flight
      // response body — so a hung request with no bytes arriving can be killed.
      let onExt = null;
      if (ctrl && cfg.abortSignal) {
        if (cfg.abortSignal.aborted) { try { ctrl.abort(); } catch (e) {} }
        else { onExt = () => { try { ctrl.abort(); } catch (e) {} }; try { cfg.abortSignal.addEventListener("abort", onExt, { once: true }); } catch (e) {} }
      }
      try {
        const resp = await fetch(url, ctrl ? Object.assign({}, opts, { signal: ctrl.signal }) : opts);
        if (timer) clearTimeout(timer);
        if ((resp.status === 429 || resp.status === 503 || resp.status === 529) && rateAttempt < rateRetries) {
          try { if (onExt && cfg.abortSignal) cfg.abortSignal.removeEventListener("abort", onExt); } catch (e2) {}
          try { if (resp.body && resp.body.cancel) resp.body.cancel(); } catch (e2) {}
          const wait = this._retryAfterMs(resp) != null ? this._retryAfterMs(resp) : Math.min(1500 * Math.pow(2, rateAttempt), 20000) + Math.floor(Math.random() * 500);
          rateAttempt++;
          this.log("rate-limited (HTTP " + resp.status + "), retry " + rateAttempt + "/" + rateRetries + " in " + wait + "ms");
          if (cfg.onRetry) { try { cfg.onRetry(resp.status, wait, rateAttempt, rateRetries); } catch (e2) {} }
          const slept = await this._sleep(wait, cfg.abortSignal);
          if (!slept) { const e = new Error("已取消"); e._cancelled = true; throw e; }
          continue; // does not consume the network-retry budget
        }
        return resp; // HTTP status handled by caller; not a network failure (leave onExt attached: it must still abort the streaming body)
      } catch (e) {
        if (timer) clearTimeout(timer);
        try { if (onExt && cfg.abortSignal) cfg.abortSignal.removeEventListener("abort", onExt); } catch (e2) {}
        lastErr = e;
        if (e && e._cancelled) throw e;
        if (cfg.abortSignal && cfg.abortSignal.aborted) throw e; // user cancelled — don't retry
        if (attempt < retries) { attempt++; this.log("fetch retry after network error: " + (e && e.message)); continue; }
        break;
      }
    }
    throw new Error("网络请求失败（已重试）：" + (lastErr && lastErr.message ? lastErr.message : lastErr));
  },

  async callLLM(messages) {
    const fmt = this._fmt();
    const resp = await this._fetchLLM(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._bodyFor(fmt, messages, false) });
    const raw = await resp.text();
    if (!resp.ok) throw this._fail(resp, raw);
    const data = this._parseOrThrow(raw);
    if (data.error) throw new Error(typeof data.error === "string" ? data.error : (data.error.message || JSON.stringify(data.error)));
    const content = this._extractContent(fmt, data);
    if (typeof content !== "string") throw new Error("无法从响应中取出内容（" + fmt + "）。实际返回：\n" + raw.slice(0, 1200));
    return content;
  },

  async callLLMStream(messages, onDelta, shouldStop, meta) {
    meta = meta || {};
    const fmt = this._fmt();
    const ab = this._abortGuard(shouldStop); // Stop aborts even a stalled connection
    try {
      // _fetchLLM retries only the connection (before any stream bytes), so a
      // mid-stream drop is never silently retried into a duplicate answer.
      const resp = await this._fetchLLM(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._bodyFor(fmt, messages, true) }, { timeoutMs: 600000, retries: 0, abortSignal: ab.signal });
      if (!resp.ok) { const raw = await resp.text().catch(() => ""); throw this._fail(resp, raw); }
      if (!resp.body || typeof resp.body.getReader !== "function") {
        const raw = await resp.text();
        const data = this._parseOrThrow(raw);
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        this._captureUsage(meta, data);
        const c = this._extractContent(fmt, data) || ""; if (c) onDelta(c); return c;
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "", full = "";
      while (true) {
        if (shouldStop && shouldStop()) { try { await reader.cancel(); } catch (e) {} break; }
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line || !line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let j; try { j = JSON.parse(payload); } catch (e) { continue; }
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          this._captureUsage(meta, j);
          const d = this._streamDelta(fmt, j);
          if (d) { full += d; onDelta(d); }
        }
      }
      return full;
    } finally { ab.dispose(); }
  },
});
