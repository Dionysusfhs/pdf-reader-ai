/* PDF Reader AI - frontend */
(() => {
  // --- PDF.js worker ---
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  // --- state ---
  const state = {
    docs: [],
    currentDoc: null,
    pdf: null,
    numPages: 0,
    currentPage: 1,
    scale: 1.25,
    pageCache: new Map(), // pageNum -> { wrap, canvas, textLayer, hlLayer, viewport }
    highlights: [],       // server highlights for current doc
    pendingSelection: null, // { text, page, rect }
    chatSelection: null,    // selection to send as context
    settings: null,
    streaming: false,
  };

  // --- dom ---
  const $ = (id) => document.getElementById(id);
  const pagesEl = $("pages");
  const emptyEl = $("empty");
  const docSelect = $("docSelect");
  const pageInput = $("pageInput");
  const pageTotal = $("pageTotal");
  const zoomLabel = $("zoomLabel");
  const toolbar = $("selToolbar");
  const kbList = $("kbList");
  const kbEmpty = $("kbEmpty");
  const kbCount = $("kbCount");
  const chatList = $("chatList");
  const chatForm = $("chatForm");
  const chatInput = $("chatInput");
  const chatSelChip = $("chatSelectionChip");
  const useSelection = $("useSelection");
  const toast = $("toast");
  const settingsDialog = $("settingsDialog");
  const settingsForm = $("settingsForm");
  const keyStatus = $("keyStatus");

  // --- helpers ---
  function showToast(msg, isError = false, ms = 2400) {
    toast.textContent = msg;
    toast.classList.remove("hidden", "error");
    if (isError) toast.classList.add("error");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add("hidden"), ms);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = res.statusText;
      try { msg = JSON.parse(text).detail || msg; } catch {}
      throw new Error(msg || `${res.status}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  // --- settings ---
  async function loadSettings() {
    state.settings = await api("/api/settings");
    for (const [k, v] of Object.entries(state.settings)) {
      const el = settingsForm.elements.namedItem(k);
      if (!el) continue;
      if (k === "api_key") {
        el.value = ""; // never prefill secrets
        keyStatus.textContent = state.settings.api_key_set ? `已配置（${v}）` : "尚未配置，请填写。";
      } else {
        el.value = v ?? "";
      }
    }
  }

  $("settingsBtn").addEventListener("click", () => {
    loadSettings().then(() => settingsDialog.showModal());
  });

  settingsForm.addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter.value !== "save") return;
    e.preventDefault();
    const fd = new FormData(settingsForm);
    const body = {};
    for (const [k, v] of fd.entries()) {
      if (k === "api_key" && !v) continue;
      body[k] = k === "temperature" ? parseFloat(v) : v;
    }
    try {
      state.settings = await api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      settingsDialog.close();
      showToast("设置已保存");
    } catch (err) { showToast("保存失败：" + err.message, true); }
  });

  // --- documents ---
  async function refreshDocs(preserveId) {
    state.docs = await api("/api/documents");
    docSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = state.docs.length ? "— 选择已打开的文档 —" : "— 还没有上传 PDF —";
    docSelect.appendChild(placeholder);
    for (const d of state.docs) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${d.title} (${d.num_pages} 页)`;
      docSelect.appendChild(opt);
    }
    if (preserveId && state.docs.some((d) => d.id === preserveId)) {
      docSelect.value = preserveId;
    }
  }

  $("uploadBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    showToast("正在上传…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const doc = await api("/api/documents", { method: "POST", body: fd });
      await refreshDocs(doc.id);
      await openDoc(doc.id);
      showToast("已打开：" + doc.title);
    } catch (err) { showToast("上传失败：" + err.message, true); }
  });

  docSelect.addEventListener("change", () => {
    const id = docSelect.value;
    if (id) openDoc(id);
  });

  $("deleteDocBtn").addEventListener("click", async () => {
    if (!state.currentDoc) return;
    if (!confirm(`删除《${state.currentDoc.title}》及其所有标注/对话？`)) return;
    try {
      await api(`/api/documents/${state.currentDoc.id}`, { method: "DELETE" });
      state.currentDoc = null;
      state.pdf = null;
      pagesEl.innerHTML = "";
      emptyEl.style.display = "";
      kbList.innerHTML = "";
      chatList.innerHTML = "";
      kbCount.textContent = "0";
      kbEmpty.classList.remove("hidden");
      await refreshDocs();
      $("deleteDocBtn").disabled = true;
      showToast("已删除");
    } catch (err) { showToast("删除失败：" + err.message, true); }
  });

  // --- open doc ---
  async function openDoc(docId) {
    try {
      const doc = await api(`/api/documents/${docId}`);
      state.currentDoc = doc;
      document.title = `${doc.title} · PDF Reader AI`;
      docSelect.value = doc.id;
      $("deleteDocBtn").disabled = false;
      emptyEl.style.display = "none";
      pagesEl.innerHTML = "";
      state.pageCache.clear();

      const task = pdfjsLib.getDocument({ url: `/api/documents/${doc.id}/file` });
      state.pdf = await task.promise;
      state.numPages = state.pdf.numPages;
      state.currentPage = 1;
      pageInput.value = 1;
      pageInput.max = state.numPages;
      pageTotal.textContent = state.numPages;
      $("prevPage").disabled = $("nextPage").disabled = false;

      for (let i = 1; i <= state.numPages; i++) {
        const wrap = document.createElement("div");
        wrap.className = "page-wrap";
        wrap.dataset.page = i;
        const num = document.createElement("div");
        num.className = "pageNumber";
        num.textContent = `第 ${i} 页`;
        wrap.appendChild(num);
        pagesEl.appendChild(wrap);
      }

      // Lazy render via intersection observer.
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              const pn = Number(e.target.dataset.page);
              renderPageInto(pn, e.target);
              io.unobserve(e.target);
            }
          }
        },
        { root: $("viewer"), rootMargin: "400px 0px" }
      );
      for (const wrap of pagesEl.children) io.observe(wrap);

      await Promise.all([refreshHighlights(), refreshMessages()]);
      updateZoomLabel();
    } catch (err) {
      showToast("打开失败：" + err.message, true);
    }
  }

  async function renderPageInto(pageNum, wrap) {
    if (state.pageCache.has(pageNum)) return;
    try {
      const page = await state.pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: state.scale });
      wrap.style.width = viewport.width + "px";
      wrap.style.height = viewport.height + "px";

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      wrap.appendChild(canvas);

      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      textLayer.style.width = viewport.width + "px";
      textLayer.style.height = viewport.height + "px";
      wrap.appendChild(textLayer);

      const hlLayer = document.createElement("div");
      hlLayer.className = "highlight-layer";
      wrap.appendChild(hlLayer);

      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const textContent = await page.getTextContent();
      await pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport,
        textDivs: [],
      }).promise;

      state.pageCache.set(pageNum, { wrap, canvas, textLayer, hlLayer, viewport });
    } catch (err) {
      console.error("renderPage", pageNum, err);
    }
  }

  // --- navigation ---
  function scrollToPage(pn) {
    const wrap = pagesEl.querySelector(`[data-page="${pn}"]`);
    if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  pageInput.addEventListener("change", () => {
    const n = Math.max(1, Math.min(state.numPages, parseInt(pageInput.value, 10) || 1));
    pageInput.value = n;
    state.currentPage = n;
    scrollToPage(n);
  });
  $("prevPage").addEventListener("click", () => {
    if (state.currentPage > 1) { state.currentPage--; pageInput.value = state.currentPage; scrollToPage(state.currentPage); }
  });
  $("nextPage").addEventListener("click", () => {
    if (state.currentPage < state.numPages) { state.currentPage++; pageInput.value = state.currentPage; scrollToPage(state.currentPage); }
  });

  // Track visible page as user scrolls.
  $("viewer").addEventListener("scroll", () => {
    const viewerRect = $("viewer").getBoundingClientRect();
    const wraps = pagesEl.children;
    let best = state.currentPage, bestDelta = Infinity;
    for (const w of wraps) {
      const r = w.getBoundingClientRect();
      const delta = Math.abs(r.top - viewerRect.top);
      if (delta < bestDelta) { bestDelta = delta; best = Number(w.dataset.page); }
    }
    if (best !== state.currentPage) {
      state.currentPage = best;
      pageInput.value = best;
    }
  });

  function updateZoomLabel() { zoomLabel.textContent = Math.round(state.scale * 100) + "%"; }
  $("zoomIn").addEventListener("click", () => { state.scale = Math.min(3, state.scale + 0.15); rerenderAll(); });
  $("zoomOut").addEventListener("click", () => { state.scale = Math.max(0.5, state.scale - 0.15); rerenderAll(); });

  async function rerenderAll() {
    updateZoomLabel();
    if (!state.pdf) return;
    state.pageCache.clear();
    for (const wrap of pagesEl.children) {
      wrap.innerHTML = "";
      const num = document.createElement("div");
      num.className = "pageNumber";
      num.textContent = `第 ${wrap.dataset.page} 页`;
      wrap.appendChild(num);
    }
    const viewer = $("viewer");
    const visiblePage = state.currentPage;
    for (const wrap of pagesEl.children) {
      const pn = Number(wrap.dataset.page);
      if (Math.abs(pn - visiblePage) <= 3) {
        await renderPageInto(pn, wrap);
      } else {
        // lazy placeholder height based on first rendered page ratio
        wrap.style.width = ""; wrap.style.height = "";
      }
    }
    // rebuild observer
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const pn = Number(e.target.dataset.page);
            renderPageInto(pn, e.target);
            io.unobserve(e.target);
          }
        }
      },
      { root: viewer, rootMargin: "400px 0px" }
    );
    for (const wrap of pagesEl.children) {
      if (!state.pageCache.has(Number(wrap.dataset.page))) io.observe(wrap);
    }
    scrollToPage(visiblePage);
  }

  // --- selection & toolbar ---
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return hideToolbar();
    const range = sel.getRangeAt(0);
    const anchorEl = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!anchorEl) return hideToolbar();
    const pageWrap = anchorEl.closest?.(".page-wrap");
    if (!pageWrap) return hideToolbar();
    const text = sel.toString().trim();
    if (text.length < 2) return hideToolbar();
    const rect = range.getBoundingClientRect();
    state.pendingSelection = {
      text,
      page: Number(pageWrap.dataset.page),
      rect,
    };
    positionToolbar(rect);
  });

  function positionToolbar(rect) {
    toolbar.classList.remove("hidden");
    const x = rect.left + rect.width / 2;
    const y = rect.top - 8;
    toolbar.style.left = Math.max(80, Math.min(window.innerWidth - 80, x)) + "px";
    toolbar.style.top = Math.max(40, y) + "px";
  }
  function hideToolbar() {
    toolbar.classList.add("hidden");
    state.pendingSelection = null;
  }
  document.addEventListener("mousedown", (e) => {
    if (!toolbar.contains(e.target)) {
      // keep selection but hide on new click that's not on toolbar
      // hide only if starting a new selection elsewhere (handled by selectionchange)
    }
  });

  toolbar.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const sel = state.pendingSelection;
    if (!sel || !state.currentDoc) return;
    const act = btn.dataset.act;
    toolbar.classList.add("hidden");
    if (act === "summarize") {
      await summarize(sel);
    } else if (act === "highlight") {
      await addHighlight(sel);
    } else if (act === "ask") {
      state.chatSelection = sel;
      showChatSelection(sel.text, sel.page);
      useSelection.checked = true;
      switchTab("chat");
      chatInput.focus();
    }
    // clear browser selection
    window.getSelection()?.removeAllRanges();
    state.pendingSelection = null;
  });

  async function summarize(sel) {
    showToast("正在总结…");
    try {
      const res = await api(`/api/documents/${state.currentDoc.id}/summarize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: sel.text, page: sel.page, save: true, style: "concise" }),
      });
      if (res.highlight) {
        state.highlights.push(res.highlight);
        renderKB();
      }
      showToast("已生成摘要并加入知识库");
    } catch (err) { showToast("总结失败：" + err.message, true); }
  }

  async function addHighlight(sel) {
    try {
      const hl = await api(`/api/documents/${state.currentDoc.id}/highlights`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: sel.text, page: sel.page }),
      });
      state.highlights.push(hl);
      renderKB();
      showToast("已加入知识库");
    } catch (err) { showToast("保存失败：" + err.message, true); }
  }

  // --- KB ---
  async function refreshHighlights() {
    if (!state.currentDoc) return;
    state.highlights = await api(`/api/documents/${state.currentDoc.id}/highlights`);
    renderKB();
  }
  function renderKB() {
    kbList.innerHTML = "";
    kbCount.textContent = state.highlights.length;
    if (!state.highlights.length) {
      kbEmpty.classList.remove("hidden");
      return;
    }
    kbEmpty.classList.add("hidden");
    const grouped = new Map();
    for (const h of state.highlights) {
      if (!grouped.has(h.page)) grouped.set(h.page, []);
      grouped.get(h.page).push(h);
    }
    const pages = [...grouped.keys()].sort((a, b) => a - b);
    for (const p of pages) {
      for (const h of grouped.get(p)) {
        kbList.appendChild(renderKBCard(h));
      }
    }
  }
  function renderKBCard(h) {
    const card = document.createElement("div");
    card.className = "kb-card";
    card.dataset.id = h.id;
    const safeText = escapeHtml(h.text);
    const summaryHTML = h.summary ? `<div class="kb-summary">${escapeHtml(h.summary)}</div>` : "";
    card.innerHTML = `
      <div class="kb-head">
        <span class="kb-page">📍 第 ${h.page} 页</span>
        <div class="kb-actions">
          <button data-act="resummarize" title="重新生成摘要">↻ 摘要</button>
          <button data-act="ask" title="就这段问 AI">💬</button>
          <button data-act="delete" title="删除">✕</button>
        </div>
      </div>
      <div class="kb-text">${safeText}</div>
      ${summaryHTML}
    `;
    card.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "delete") return deleteHighlight(h);
        if (act === "resummarize") return resummarize(h);
        if (act === "ask") return askAboutHighlight(h);
        return;
      }
      jumpToPage(h.page, h.text);
    });
    return card;
  }
  async function deleteHighlight(h) {
    try {
      await api(`/api/highlights/${h.id}`, { method: "DELETE" });
      state.highlights = state.highlights.filter((x) => x.id !== h.id);
      renderKB();
    } catch (err) { showToast("删除失败：" + err.message, true); }
  }
  async function resummarize(h) {
    showToast("重新生成摘要…");
    try {
      const res = await api(`/api/documents/${state.currentDoc.id}/summarize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: h.text, page: h.page, save: false, style: "concise" }),
      });
      const updated = await api(`/api/highlights/${h.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: res.summary }),
      });
      Object.assign(h, updated);
      renderKB();
      showToast("摘要已更新");
    } catch (err) { showToast("失败：" + err.message, true); }
  }
  function askAboutHighlight(h) {
    state.chatSelection = { text: h.text, page: h.page };
    showChatSelection(h.text, h.page);
    useSelection.checked = true;
    switchTab("chat");
    chatInput.focus();
  }
  function jumpToPage(page, matchText) {
    scrollToPage(page);
    setTimeout(() => flashHighlight(page, matchText), 350);
  }

  function flashHighlight(page, needle) {
    const cache = state.pageCache.get(page);
    if (!cache || !needle) return;
    const spans = cache.textLayer.querySelectorAll("span");
    const parts = needle.replace(/\s+/g, " ").slice(0, 40);
    for (const sp of spans) {
      if (sp.textContent && parts.includes(sp.textContent.trim().slice(0, 12)) && sp.textContent.trim().length > 2) {
        const r = sp.getBoundingClientRect();
        const wr = cache.wrap.getBoundingClientRect();
        const flash = document.createElement("div");
        flash.className = "hl-flash";
        flash.style.left = (r.left - wr.left) + "px";
        flash.style.top = (r.top - wr.top) + "px";
        flash.style.width = r.width + "px";
        flash.style.height = r.height + "px";
        cache.hlLayer.appendChild(flash);
        setTimeout(() => flash.remove(), 1500);
      }
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // --- tabs ---
  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  // --- chat ---
  async function refreshMessages() {
    chatList.innerHTML = "";
    if (!state.currentDoc) return;
    const msgs = await api(`/api/documents/${state.currentDoc.id}/messages`);
    for (const m of msgs) appendMessage(m.role, m.content);
    chatList.scrollTop = chatList.scrollHeight;
  }
  function appendMessage(role, content) {
    const b = document.createElement("div");
    b.className = `bubble ${role}`;
    if (role === "assistant") b.innerHTML = renderMarkdown(content);
    else b.textContent = content;
    chatList.appendChild(b);
    chatList.scrollTop = chatList.scrollHeight;
    return b;
  }
  function renderMarkdown(s) {
    try { return window.marked.parse(s, { breaks: true, gfm: true }); }
    catch { return escapeHtml(s).replace(/\n/g, "<br>"); }
  }

  function showChatSelection(text, page) {
    chatSelChip.classList.remove("hidden");
    chatSelChip.textContent = `📎 已附加（第 ${page} 页）：${text.length > 160 ? text.slice(0, 160) + "…" : text}`;
  }
  function hideChatSelection() {
    chatSelChip.classList.add("hidden");
    chatSelChip.textContent = "";
    state.chatSelection = null;
    useSelection.checked = false;
  }
  useSelection.addEventListener("change", () => {
    if (!useSelection.checked) hideChatSelection();
  });

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendChat();
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  async function sendChat() {
    if (state.streaming) return;
    const msg = chatInput.value.trim();
    if (!msg) return;
    if (!state.currentDoc) { showToast("请先打开一个 PDF", true); return; }
    chatInput.value = "";
    appendMessage("user", msg);
    const assistantBubble = appendMessage("assistant", "");
    assistantBubble.classList.add("thinking");
    state.streaming = true;
    $("sendBtn").disabled = true;

    const body = {
      message: msg,
      current_page: state.currentPage,
      selection: useSelection.checked && state.chatSelection ? state.chatSelection.text : null,
    };

    try {
      const res = await fetch(`/api/documents/${state.currentDoc.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(text || res.statusText);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", full = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!chunk.startsWith("data:")) continue;
          const payload = chunk.slice(5).trim();
          try {
            const j = JSON.parse(payload);
            if (j.delta) {
              full += j.delta;
              assistantBubble.innerHTML = renderMarkdown(full);
              chatList.scrollTop = chatList.scrollHeight;
            }
            if (j.done) { /* noop */ }
          } catch {}
        }
      }
      assistantBubble.classList.remove("thinking");
      if (!full) assistantBubble.textContent = "(无回复)";
      hideChatSelection();
    } catch (err) {
      assistantBubble.classList.remove("thinking");
      assistantBubble.textContent = "出错了：" + err.message;
      showToast("对话失败：" + err.message, true);
    } finally {
      state.streaming = false;
      $("sendBtn").disabled = false;
    }
  }

  $("clearChatBtn").addEventListener("click", async () => {
    if (!state.currentDoc) return;
    if (!confirm("清空当前文档的全部对话历史？")) return;
    try {
      await api(`/api/documents/${state.currentDoc.id}/messages`, { method: "DELETE" });
      chatList.innerHTML = "";
    } catch (err) { showToast("清空失败：" + err.message, true); }
  });

  // --- bootstrap ---
  (async function init() {
    try {
      await loadSettings();
      await refreshDocs();
      if (!state.settings.api_key_set) {
        showToast("提示：请先在设置里填写 API Key 才能使用 AI 功能", false, 4200);
      }
    } catch (err) {
      showToast("初始化失败：" + err.message, true);
    }
  })();
})();
